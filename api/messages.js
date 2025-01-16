const express = require("express");
const router = express.Router();
const { OpenAI } = require("openai");
const { OpenAIEmbeddings } = require("@langchain/openai");
const { PineconeStore } = require("@langchain/pinecone");
const { Pinecone } = require("@pinecone-database/pinecone");
const supabase = require("../supabase");
const pusher = require("../pusher");

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

async function getAIResponse(userMessage, relevantContext) {
  try {
    console.log("Context being used:", relevantContext);
    
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: `Your name is Piggy. You are a helpful and knowledgeable foodie who has travelled the world and knows a lot about food. 
          If available, use this context from previous conversations: ${relevantContext || 'No context available'}
          
          Be friendly, conversational, and share specific details about the food scene when relevant.
          If you don't have relevant context for a specific query, just share your general knowledge about food.`
        },
        { role: "user", content: userMessage }
      ],
      temperature: 0.7,
      max_tokens: 500
    });

    return response.choices[0].message.content;
  } catch (error) {
    console.error("Error getting AI response:", error);
    return "I apologize, but I'm having trouble processing your request right now. Could you please try again?";
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
      const { userId } = req.auth;
      const { content, files, conversation_id, parent_message_id } = req.body;

      // Allow empty content if files are present
      if (!content && (!files || files.length === 0)) {
        return res.status(400).json({ error: "Content or files required" });
      }

      if (!conversation_id) {
        return res.status(400).json({ error: "Conversation ID required" });
      }

      // Get conversation members with retry
      const { data: members, error: membersError } = await retryOperation(async () => 
        await supabase
          .from("conversation_members")
          .select("user_id")
          .eq("conversation_id", conversation_id)
      );

      if (membersError) throw membersError;

      // Create message with file attachments
      const { data: message, error } = await retryOperation(async () =>
        await supabase
          .from("messages")
          .insert([
            {
              content: content || '', // Ensure content is never null
              conversation_id,
              created_by: userId,
              file_attachments: files || null,
              parent_message_id: parent_message_id || null,
            },
          ])
          .select()
          .single()
      );

      if (error) throw error;

      // Trigger Pusher event for user's message
      await pusher.trigger(
        `conversation-${conversation_id}`,
        "new-message",
        message
      );

      // Check if AI is in the conversation
      const hasAI = members.some(member => member.user_id === "user_ai");
      
      if (hasAI) {
        try {
          const relevantContext = await retryOperation(() => 
            searchSimilarMessages(content, conversation_id)
          );
          
          const aiResponse = await retryOperation(() => 
            getAIResponse(content, relevantContext)
          );

          const { data: aiMessage, error: aiError } = await retryOperation(async () =>
            await supabase
              .from("messages")
              .insert([{
                content: aiResponse,
                conversation_id,
                created_by: "user_ai"
              }])
              .select()
              .single()
          );

          if (aiError) throw aiError;

          await retryOperation(() =>
            pusher.trigger(
              `conversation-${conversation_id}`,
              "new-message",
              aiMessage
            )
          );
        } catch (aiError) {
          console.error("Error generating AI response:", aiError);
          // Continue execution even if AI response fails
        }
      }

      res.json(message);
    } catch (error) {
      console.error("Error:", error);
      res.status(500).json({ 
        error: "Error creating message",
        details: error.message 
      });
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
