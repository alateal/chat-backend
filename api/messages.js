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

async function searchSimilarMessages(query, limit = 5) {
  try {
    const store = await initVectorStore();
    console.log("Searching for:", query);
    
    const results = await store.similaritySearch(query, limit);
    console.log("Search results:", results);
    
    // Format results for context
    const formattedContext = results
      .map(doc => `Message: ${doc.metadata.content}`)
      .join('\n');
      
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
          content: `You are a helpful and knowledgeable foodie who has been living in New York for a long time. 
          If available, use this context from previous conversations: ${relevantContext || 'No context available'}
          
          Be friendly, conversational, and share specific details about NYC food scene when relevant.
          If you don't have relevant context for a specific query, just share your general knowledge about NYC food.`
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

      if (!content && !files?.length) {
        return res.status(400).json({ error: "Content or files required" });
      }

      if (!conversation_id) {
        return res.status(400).json({ error: "Conversation ID required" });
      }

      // Get conversation members to check for AI
      const { data: members, error: membersError } = await supabase
        .from("conversation_members")
        .select("user_id")
        .eq("conversation_id", conversation_id);

      if (membersError) throw membersError;

      // Create user's message
      const { data: message, error } = await supabase
        .from("messages")
        .insert([
          {
            content,
            conversation_id,
            created_by: userId,
            file_attachments: files?.length ? files : null,
            parent_message_id: parent_message_id || null,
          },
        ])
        .select()
        .single();

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
        console.log("AI conversation detected, searching for context...");
        
        // Search for relevant context
        const relevantContext = await searchSimilarMessages(content);
        console.log("Found relevant context:", relevantContext);
        
        // Get AI response
        const aiResponse = await getAIResponse(content, relevantContext);
        console.log("Generated AI response");

        // Create AI's response
        const { data: aiMessage, error: aiError } = await supabase
          .from("messages")
          .insert([
            {
              content: aiResponse,
              conversation_id,
              created_by: "user_ai"
            }
          ])
          .select()
          .single();

        if (aiError) throw aiError;

        // Trigger Pusher event for AI's message
        await pusher.trigger(
          `conversation-${conversation_id}`,
          "new-message",
          aiMessage
        );
      }

      res.json(message);
    } catch (error) {
      console.error("Error:", error);
      res.status(500).json({ error: "Error creating message" });
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
