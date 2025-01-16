const dotenv = require("dotenv").config();
const { OpenAI } = require("openai");
const { OpenAIEmbeddings } = require("@langchain/openai");
const { PineconeStore } = require("@langchain/pinecone");
const { Pinecone } = require("@pinecone-database/pinecone");
const supabase = require("../supabase");

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Initialize OpenAI embeddings
const embeddings = new OpenAIEmbeddings({
  modelName: "text-embedding-3-small",
  openAIApiKey: process.env.OPENAI_API_KEY,
});

// Initialize Pinecone client
const pc = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY
});

// Get Pinecone index
const index = pc.index("chatgenius-small");

async function getLatestPineconeId() {
  try {
    // Query Pinecone for the latest messageId
    const queryResponse = await index.query({
      topK: 1,
      includeMetadata: true,
      vector: Array(1536).fill(0), // Dummy vector for query
      filter: {}, // No filter needed
    });

    if (queryResponse.matches && queryResponse.matches.length > 0) {
      return parseInt(queryResponse.matches[0].metadata.messageId);
    }
    return 0; // Return 0 if no messages exist
  } catch (error) {
    console.error("Error getting latest Pinecone ID:", error);
    return 0;
  }
}

// Add new function to analyze message content
async function analyzeMessage(message) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: `Analyze the message and determine:
          1. If it's a question
          2. If it contains important food-related information (recommendations, experiences, preferences)
          3. Extract only the important food information if present, preserving specific details like restaurant names, dishes, and locations
          
          Respond in JSON format:
          {
            "isQuestion": boolean,
            "hasFoodInfo": boolean,
            "extractedInfo": string or null,
            "context": {
              "location": string or null,
              "cuisine": string or null,
              "type": "recommendation" | "experience" | "preference" | "question"
            }
          }`
        },
        { role: "user", content: message.content }
      ],
      temperature: 0,
      max_tokens: 300
    });

    return JSON.parse(response.choices[0].message.content);
  } catch (error) {
    console.error("Error analyzing message:", error);
    return {
      isQuestion: false,
      hasFoodInfo: false,
      extractedInfo: null,
      context: { location: null, cuisine: null, type: null }
    };
  }
}

// Add helper function to handle null metadata values
function sanitizeMetadata(metadata) {
  const sanitized = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === null || value === undefined) {
      sanitized[key] = ''; // Convert null/undefined to empty string
    } else if (Array.isArray(value)) {
      sanitized[key] = value.map(v => v === null ? '' : v.toString());
    } else {
      sanitized[key] = value.toString(); // Convert all values to strings
    }
  }
  return sanitized;
}

async function addMessagesToVectorStore() {
  try {
    console.log("Getting latest message ID from Pinecone...");
    const latestPineconeId = await getLatestPineconeId();
    console.log("Latest Pinecone message ID:", latestPineconeId);

    console.log("Fetching new messages from Supabase...");
    const { data: messages, error } = await supabase
      .from("messages")
      .select("*")
      .gt("id", latestPineconeId) // Only get messages newer than the latest in Pinecone
      .order("created_at", { ascending: true });

    if (error) throw error;
    
    if (messages.length === 0) {
      console.log("No new messages to add to vector store");
      return 0;
    }
    
    console.log(`Found ${messages.length} new messages to process`);

    // Filter out AI responses and analyze user messages
    const messagesToProcess = [];
    
    for (const message of messages) {
      // Skip AI responses
      if (message.created_by === "user_ai") continue;

      // Analyze user message
      const analysis = await analyzeMessage(message);
      
      if (analysis.hasFoodInfo) {
        messagesToProcess.push({
          ...message,
          content: analysis.extractedInfo || message.content,
          context: analysis.context
        });
      }
    }

    if (messagesToProcess.length === 0) {
      console.log("No relevant messages to add to vector store");
      return 0;
    }

    console.log(`Processing ${messagesToProcess.length} relevant messages`);

    // Create embeddings for filtered messages
    const messageContentEmbeddings = await embeddings.embedDocuments(
      messagesToProcess.map((message) => message.content)
    );

    // Prepare vectors for Pinecone with enhanced metadata
    const messageVectors = messageContentEmbeddings.map((embedding, index) => {
      const message = messagesToProcess[index];
      const context = message.context || {};
      
      // Prepare metadata with sanitization
      const metadata = sanitizeMetadata({
        messageId: message.id,
        originalMessageId: message.id,
        conversationId: message.conversation_id,
        parentConversationId: message.conversation_id,
        created_at: message.created_at,
        created_by: message.created_by,
        content: message.content,
        location: context.location,
        cuisine: context.cuisine,
        type: context.type
      });

      return {
        id: message.id.toString(),
        values: embedding,
        metadata
      };
    });

    // Upsert vectors to Pinecone
    console.log("Adding new vectors to Pinecone...");
    await index.upsert(messageVectors);

    console.log(`Successfully added ${messageVectors.length} relevant messages to Pinecone`);
    return messageVectors.length;
  } catch (error) {
    console.error("Error adding messages to vector store:", error);
    throw error;
  }
}

// Execute the function
addMessagesToVectorStore();
