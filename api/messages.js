const express = require("express");
const router = express.Router();
const { OpenAI } = require("openai");
const { OpenAIEmbeddings } = require("@langchain/openai");
const { PineconeStore } = require("@langchain/pinecone");
const { Pinecone } = require("@pinecone-database/pinecone");
const supabase = require("../supabase");
const pusher = require("../pusher");
const { searchFiles } = require('../utils/fileSearch');
const { generateAudioForMessage } = require('../utils/audioService');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const embeddings = new OpenAIEmbeddings({
  modelName: "text-embedding-3-small",
  openAIApiKey: process.env.OPENAI_API_KEY,
});

// Initialize Pinecone client
const pc = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY
});

// Initialize vector store once
let vectorStore = null;

const activeResponses = new Map(); // Track messages being processed with timestamps

async function initVectorStore() {
  if (!vectorStore) {
    try {
      const pineconeIndex = pc.index(process.env.PINECONE_INDEX);
      vectorStore = await PineconeStore.fromExistingIndex(embeddings, {
        pineconeIndex,
      });
      console.log("Vector store initialized successfully");
    } catch (error) {
      console.error("Error initializing vector store:", error);
      throw error;
    }
  }
  return vectorStore;
}

async function generateMessageVariations(message) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: `You are a helpful assistant. Please rephrase the following message in 5 different ways, 
          focusing on food-related aspects. Keep the same meaning but use different words and structures. 
          Format your response as a numbered list from 1-5.`
        },
        { role: "user", content: message }
      ],
      temperature: 0.7,
      max_tokens: 300
    });

    // Extract the variations from the response
    const variations = response.choices[0].message.content
      .split('\n')
      .filter(line => line.trim().match(/^\d+\./)) // Get only numbered lines
      .map(line => line.replace(/^\d+\.\s*/, '')); // Remove numbers

    console.log("Generated variations:", variations);
    return variations;
  } catch (error) {
    console.error("Error generating variations:", error);
    return [message]; // Return original message if error
  }
}

async function analyzeSearchResults(searchResults) {
  try {
    if (!searchResults || searchResults.length === 0) {
      return [];
    }

    // Batch analyze all search results at once for efficiency
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: `Analyze each message and determine if it's a question or contains food recommendations.
          For each message, respond with an object containing:
          - isQuestion: true if it's a question, false otherwise
          - hasFoodRecommendation: true if it contains food recommendations, false otherwise
          
          Respond with a JSON array matching the number of input messages.
          Example: [{"isQuestion": true, "hasFoodRecommendation": false}, {"isQuestion": false, "hasFoodRecommendation": true}]`
        },
        {
          role: "user",
          content: JSON.stringify(searchResults.map(doc => doc.metadata.content))
        }
      ],
      temperature: 0,
      max_tokens: 500
    });

    let analysisArray;
    try {
      analysisArray = JSON.parse(response.choices[0].message.content);
      
      // Validate that we got an array
      if (!Array.isArray(analysisArray)) {
        console.error("Response is not an array:", analysisArray);
        return searchResults;
      }
      
    } catch (parseError) {
      console.error("Error parsing OpenAI response:", parseError);
      return searchResults;
    }

    // Pair each result with its analysis and sort
    const analyzedResults = searchResults.map((doc, index) => ({
      ...doc,
      analysis: {
        isQuestion: !!analysisArray[index]?.isQuestion,
        hasFoodRecommendation: !!analysisArray[index]?.hasFoodRecommendation
      }
    }));

    // Sort results: food recommendations first, then non-questions, then questions
    return analyzedResults.sort((a, b) => {
      // Helper function to get sort priority
      const getPriority = (result) => {
        if (!result.analysis) return 2; // Default priority if analysis is missing
        if (result.analysis.hasFoodRecommendation) return 0;
        if (!result.analysis.isQuestion) return 1;
        return 2;
      };

      return getPriority(a) - getPriority(b);
    });

  } catch (error) {
    console.error("Error analyzing search results:", error);
    return searchResults; // Return original results if analysis fails
  }
}

async function searchSimilarMessages(query, conversationId, limit = 5) {
  try {
    const store = await initVectorStore();
    console.log("Searching for context using variations...");
    
    // Generate variations of the query
    const queryVariations = await generateMessageVariations(query);
    
    // Search for each variation
    const searchPromises = queryVariations.map(variation => 
      store.similaritySearch(variation, 2, {
        filter: (doc) => {
          if (doc.metadata.content === query) return false;
          
          return (
            doc.metadata.conversationId === conversationId ||
            doc.metadata.created_by === "user_ai" ||
            doc.metadata.content.toLowerCase().includes("food") ||
            doc.metadata.content.toLowerCase().includes("restaurant") ||
            doc.metadata.content.toLowerCase().includes("place") ||
            doc.metadata.content.toLowerCase().includes("eat")
          );
        }
      })
    );

    // Combine all search results
    const allResults = (await Promise.all(searchPromises)).flat();

    // Analyze and prioritize results
    const analyzedResults = await analyzeSearchResults(allResults);
    
    // Enhanced deduplication with similarity check
    const uniqueResults = [];
    const seenContent = new Set();
    
    analyzedResults.forEach(doc => {
      const content = doc.metadata.content.toLowerCase().trim();
      
      if (seenContent.has(content)) return;
      
      // Check for similar content using basic similarity
      const isTooSimilar = uniqueResults.some(existingDoc => {
        const existingContent = existingDoc.metadata.content.toLowerCase().trim();
        
        // Check if one string contains most of the other
        if (existingContent.includes(content) || content.includes(existingContent)) {
          return true;
        }
        
        // Check for word overlap
        const words1 = new Set(content.split(/\s+/));
        const words2 = new Set(existingContent.split(/\s+/));
        const overlap = [...words1].filter(word => words2.has(word)).length;
        const similarity = overlap / Math.max(words1.size, words2.size);
        
        return similarity > 0.7; // Adjust threshold as needed
      });
      
      if (!isTooSimilar) {
        uniqueResults.push(doc);
        seenContent.add(content);
      }
    });
    
    const formattedContext = uniqueResults
      .sort((a, b) => new Date(a.metadata.created_at) - new Date(b.metadata.created_at))
      .map(doc => {
        const prefix = doc.metadata.created_by === "user_ai" ? "Piggy" : "User";
        const conversationType = doc.metadata.conversationId === conversationId 
          ? "current conversation" 
          : "related conversation";
        return `${prefix} (${conversationType}): ${doc.metadata.content}`;
      })
      .join('\n\n');

    console.log("Found unique conversations:", uniqueResults.length);
    return formattedContext;
  } catch (error) {
    console.error("Error searching similar messages:", error);
    return "";
  }
}

async function getAIResponse(content, relevantContext) {
  try {
    // Search for relevant file content
    const fileResults = await searchFiles(content);
    
    // Prepare context from both conversation history and files
    let contextPrompt = "";
    
    if (relevantContext && typeof relevantContext === 'string') {
      contextPrompt += "\nRelevant conversation history:\n" + relevantContext;
    }

    if (fileResults.chunks.length > 0) {
      contextPrompt += "\nRelevant information from files:\n" + 
        fileResults.chunks.map(chunk => 
          `- From ${chunk.fileName}: ${chunk.content}`
        ).join("\n");
    }

    if (fileResults.summaries.length > 0) {
      contextPrompt += "\nRelevant file summaries:\n" + 
        fileResults.summaries.map(summary => 
          `- Summary of ${summary.fileName}: ${summary.content}`
        ).join("\n");
    }

    // Generate AI response
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: `Your name is Piggy. You are a helpful and knowledgeable foodie who has travelled the world and knows a lot about food.
          When answering questions:
          1. Use the provided context from conversations and files if relevant
          2. If you reference information from files, mention the file name
          3. Be friendly, conversational, and share specific details about the food scene when relevant
          4. If you're not sure about something, say so rather than making assumptions
          5. Keep your responses concise and to the point, preferably under 30 words, but friendly and conversational.`
        },
        {
          role: "user",
          content: `Context:\n${contextPrompt}\n\nUser message: ${content}`
        }
      ],
      temperature: 0.7,
      max_tokens: 500
    });

    const textResponse = response.choices[0].message.content;
    
    // Generate audio for the response
    let audioUrl = null;
    try {
      const audioResult = await generateAudioForMessage(
        textResponse,
        `ai_${Date.now()}`
      );
      audioUrl = audioResult.url;
    } catch (audioError) {
      console.error("Error generating audio:", audioError);
      // Continue without audio if generation fails
    }

    return {
      text: textResponse,
      audioUrl
    };
  } catch (error) {
    console.error("Error generating AI response:", error);
    return {
      text: "I apologize, but I encountered an error while processing your request. Please try again.",
      audioUrl: null
    };
  }
}

// Add retry utility function at the top
async function retryOperation(operation, maxRetries = 3, delay = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      
      console.log(`Attempt ${i + 1} failed, retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      // Exponential backoff
      delay *= 2;
    }
  }
}

// Add cleanup function to remove stale locks
function cleanupStaleLocks() {
  const now = Date.now();
  for (const [conversationId, timestamp] of activeResponses.entries()) {
    // Remove locks older than 30 seconds
    if (now - timestamp > 30000) {
      activeResponses.delete(conversationId);
    }
  }
}

// Fix the acquireLock function - it was returning true when locked!
function acquireLock(conversationId) {
  cleanupStaleLocks();
  if (activeResponses.has(conversationId)) {
    return false; // Return false if already locked
  }
  activeResponses.set(conversationId, Date.now());
  return true;
}

function releaseLock(conversationId) {
  activeResponses.delete(conversationId);
}

// Add function to check if Piggy is in conversation
async function isPiggyInConversation(conversationId) {
  try {
    const { data: members, error } = await supabase
      .from("conversation_members")
      .select("user_id")
      .eq("conversation_id", conversationId)
      .eq("user_id", "user_ai")
      .single();

    if (error) {
      console.error("Error checking Piggy participation:", error);
      return false;
    }

    return !!members;
  } catch (error) {
    console.error("Error in isPiggyInConversation:", error);
    return false;
  }
}

module.exports = function () {
  // Initialize vector store when the server starts
  initVectorStore().catch(console.error);

  router.get("/", async (req, res) => {
    try {
      const { data: messages, error } = await supabase
        .from("messages")
        .select("*")
        .order("created_at", { ascending: true });

      if (error) throw error;

      res.json({ messages });
    } catch (error) {
      console.error("Error:", error);
      res.status(500).json({ error: "Error fetching messages" });
    }
  });

  router.post("/", async (req, res) => {
    try {
      const { content, conversation_id, parent_message_id, file_attachments, files } = req.body;
      const user_id = req.auth.userId;

      // Debug logging
      console.log("Raw request body:", req.body);

      // Validate conversation_id
      if (!conversation_id) {
        return res.status(400).json({ error: "conversation_id is required" });
      }

      // Validate and process file attachments - handle both files and file_attachments
      let validFiles = [];
      const attachments = files || file_attachments; // Use whichever is present

      if (attachments) {
        console.log("Processing attachments:", attachments);
        
        // Ensure attachments is an array
        const fileArray = Array.isArray(attachments) ? attachments : [attachments];
        
        validFiles = fileArray.filter(file => {
          if (!file) return false;
          
          // Handle both naming conventions
          const fileName = file.name || file.file_name;
          const fileType = file.type || file.file_type;
          const fileUrl = file.url || file.file_url;
          const fileSize = file.size || file.file_size;

          const isValid = fileName && fileType && fileUrl;
          
          if (isValid) {
            // Normalize the file object structure
            return {
              name: fileName,
              type: fileType,
              url: fileUrl,
              size: fileSize || 0
            };
          }

          console.log("Invalid file:", file);
          return false;
        });
      }

      // Log valid files
      console.log("Valid files after processing:", validFiles);

      // Check for valid content or files
      const hasContent = content && content.trim().length > 0;
      const hasFiles = validFiles.length > 0;

      if (!hasContent && !hasFiles) {
        return res.status(400).json({ 
          error: "Message must contain either text content or valid file attachments" 
        });
      }

      // Create message object
      const messageData = {
        content: content || '', 
        conversation_id,
        created_by: user_id,
        parent_message_id: parent_message_id || null,
        file_attachments: validFiles.length > 0 ? validFiles : null
      };

      console.log("Final message data:", messageData);

      // Insert message
      const { data: message, error } = await supabase
        .from("messages")
        .insert([messageData])
        .select()
        .single();

      if (error) {
        console.error("Database error:", error);
        throw error;
      }

      // Emit the user message
      await pusher.trigger(
        `conversation-${conversation_id}`,
        "new-message",
        message
      );

      // Update isPiggyInConversation to handle no results
      const piggyParticipation = await supabase
        .from("conversation_members")
        .select("user_id")
        .eq("conversation_id", conversation_id)
        .eq("user_id", "user_ai");

      const piggyIsParticipant = piggyParticipation.data && piggyParticipation.data.length > 0;

      // Check if this is a message that should trigger Piggy's response
      const shouldRespond = user_id !== 'user_ai' && 
                           !parent_message_id && 
                           piggyIsParticipant;

      if (shouldRespond && acquireLock(conversation_id)) {
        try {
          let contextContent = content || '';
          
          // If there are file attachments, add them to the context with more details
          if (file_attachments && file_attachments.length > 0) {
            contextContent += '\n[User shared files: ' + 
              file_attachments.map(file => 
                `${file.name} (${file.type})`
              ).join(', ') + ']';
          }

          const relevantContext = await retryOperation(() => 
            searchSimilarMessages(contextContent, conversation_id)
          );
          
          const aiResponse = await retryOperation(() => 
            getAIResponse(contextContent, relevantContext)
          );

          // Insert AI message with audio URL
          const { data: aiMessage, error: aiError } = await retryOperation(async () =>
            await supabase
              .from("messages")
              .insert([{
                content: aiResponse.text,
                conversation_id,
                created_by: "user_ai",
                audio_url: aiResponse.audioUrl // Add audio URL to the message
              }])
              .select()
              .single()
          );

          if (aiError) throw aiError;

          // Emit AI message with audio URL
          await retryOperation(() =>
            pusher.trigger(
              `conversation-${conversation_id}`,
              "new-message",
              aiMessage
            )
          );
        } catch (aiError) {
          console.error("Error generating AI response:", aiError);
        } finally {
          releaseLock(conversation_id);
        }
      }

      res.json(message);
    } catch (error) {
      console.error("Error in POST /messages:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/:messageId/reactions", async (req, res) => {
    try {
      const { userId } = req.auth;
      const { messageId } = req.params;
      const { emoji } = req.body;

      // Get message with both channel_id and conversation_id
      const { data: message, error: fetchError } = await supabase
        .from("messages")
        .select("reactions, conversation_id")
        .eq("id", messageId)
        .single();

      if (fetchError) throw fetchError;

      // Update or create the reaction
      let reactions = message.reactions || [];
      const existingReactionIndex = reactions.findIndex(
        (r) => r.emoji === emoji
      );

      if (existingReactionIndex >= 0) {
        if (reactions[existingReactionIndex].users.includes(userId)) {
          reactions[existingReactionIndex].users = reactions[
            existingReactionIndex
          ].users.filter((id) => id !== userId);
          if (reactions[existingReactionIndex].users.length === 0) {
            reactions = reactions.filter(
              (_, index) => index !== existingReactionIndex
            );
          }
        } else {
          reactions[existingReactionIndex].users.push(userId);
        }
      } else {
        reactions.push({
          emoji,
          users: [userId],
        });
      }

      // Update the message
      const { data: updatedMessage, error: updateError } = await supabase
        .from("messages")
        .update({ reactions })
        .eq("id", messageId)
        .select()
        .single();

      if (updateError) throw updateError;


      // Trigger appropriate Pusher event based on message type
      const eventChannel = `conversation-${message.conversation_id}`;

      await pusher.trigger(eventChannel, "message-updated", updatedMessage);

      res.json(updatedMessage);
    } catch (error) {
      console.error("Error updating reaction:", error);
      res.status(500).json({ error: "Error updating reaction" });
    }
  });

  return router;
};
