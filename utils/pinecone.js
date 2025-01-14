const dotenv = require("dotenv").config();
const { OpenAIEmbeddings } = require("@langchain/openai");
const { PineconeStore } = require("@langchain/pinecone");
const { Pinecone: PineconeClient } = require("@pinecone-database/pinecone");
const supabase = require("../supabase");

// Initialize OpenAI embeddings with the small model
const embeddings = new OpenAIEmbeddings({
  modelName: "text-embedding-3-small",
  openAIApiKey: process.env.OPENAI_API_KEY,
});

function initPinecone() {
  const client = new PineconeClient();
  return client;
}

async function addMessagesToVectorStore() {
  try {
    console.log("Fetching messages from Supabase...");
    const { data: messages, error } = await supabase
      .from("messages")
      .select("*")
      .order("created_at", { ascending: true });

    if (error) throw error;
    console.log(`Found ${messages.length} messages`);

    const messageContentEmbeddings = await embeddings.embedDocuments(messages.map((message) => message.content));

    const messageVectors = messageContentEmbeddings.map((embedding, index) => ({
      id: messages[index].id.toString(),
      values: embedding,
      metadata: {
        messageId: messages[index].id,
        userId: messages[index].user_id,
        conversationId: messages[index].conversation_id,
        created_at: messages[index].created_at,
        created_by: messages[index].created_by,
      },
    }));

    // Initialize Pinecone
    const pinecone = initPinecone();
    const pineconeIndex = pinecone.Index(process.env.PINECONE_INDEX);

    // Create vector store and add documents
    console.log("Adding documents to Pinecone...");
    pineconeIndex.upsert(messageVectors);

    console.log("Successfully added messages to Pinecone");
    return messageVectors.length;
  } catch (error) {
    console.error("Error adding messages to vector store:", error);
    throw error;
  }
}

// Function to search similar messages
async function searchSimilarMessages(query, limit = 5) {
  try {
    const pinecone = await initPinecone();
    const pineconeIndex = pinecone.Index(process.env.PINECONE_INDEX);

    const vectorStore = await PineconeStore.fromExistingIndex(embeddings, {
      pineconeIndex,
      namespace: "", // optional
    });

    const results = await vectorStore.similaritySearch(query, limit);
    return results;
  } catch (error) {
    console.error("Error searching similar messages:", error);
    throw error;
  }
}

addMessagesToVectorStore();
