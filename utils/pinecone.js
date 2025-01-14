const dotenv = require("dotenv").config();
const { OpenAIEmbeddings } = require("@langchain/openai");
const { PineconeStore } = require("@langchain/pinecone");
const { Pinecone } = require("@pinecone-database/pinecone");
const supabase = require("../supabase");

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

async function addMessagesToVectorStore() {
  try {
    console.log("Fetching messages from Supabase...");
    const { data: messages, error } = await supabase
      .from("messages")
      .select("*")
      .order("created_at", { ascending: true });

    if (error) throw error;
    console.log(`Found ${messages.length} messages`);

    // Create embeddings for all messages
    const messageContentEmbeddings = await embeddings.embedDocuments(
      messages.map((message) => message.content)
    );

    // Prepare vectors for Pinecone
    const messageVectors = messageContentEmbeddings.map((embedding, index) => ({
      id: messages[index].id.toString(),
      values: embedding,
      metadata: {
        messageId: messages[index].id,
        userId: messages[index].user_id,
        conversationId: messages[index].conversation_id,
        created_at: messages[index].created_at,
        created_by: messages[index].created_by,
        content: messages[index].content
      },
    }));

    // Upsert vectors to Pinecone
    console.log("Adding vectors to Pinecone...");
    await index.upsert(messageVectors);

    console.log("Successfully added messages to Pinecone");
    return messageVectors.length;
  } catch (error) {
    console.error("Error adding messages to vector store:", error);
    throw error;
  }
}

// Execute the function
addMessagesToVectorStore();
