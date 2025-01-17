const { OpenAIEmbeddings } = require("@langchain/openai");
const { Pinecone } = require("@pinecone-database/pinecone");

// Initialize OpenAI embeddings
const embeddings = new OpenAIEmbeddings({
  modelName: "text-embedding-3-small",
  openAIApiKey: process.env.OPENAI_API_KEY,
});

// Initialize Pinecone client
const pc = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY
});

const chunksIndex = pc.index(process.env.PIGGY_CHUNKS_INDEX || "piggy-chunks");
const summariesIndex = pc.index(process.env.PIGGY_SUMMARIES_INDEX || "piggy-summaries");

async function searchFiles(query, limit = 3) {
  try {
    // Create embedding for the query
    const queryEmbedding = await embeddings.embedQuery(query);

    // Search both chunks and summaries
    const [chunkResults, summaryResults] = await Promise.all([
      chunksIndex.query({
        vector: queryEmbedding,
        topK: limit,
        includeMetadata: true
      }),
      summariesIndex.query({
        vector: queryEmbedding,
        topK: 1,
        includeMetadata: true
      })
    ]);

    // Format results
    const chunks = chunkResults.matches.map(match => ({
      content: match.metadata.content,
      fileName: match.metadata.fileName,
      score: match.score,
      type: 'chunk'
    }));

    const summaries = summaryResults.matches.map(match => ({
      content: match.metadata.content,
      fileName: match.metadata.fileName,
      score: match.score,
      type: 'summary'
    }));

    return {
      chunks,
      summaries,
      relevantFiles: [...new Set([...chunks, ...summaries].map(r => r.fileName))]
    };
  } catch (error) {
    console.error("Error searching files:", error);
    return { chunks: [], summaries: [], relevantFiles: [] };
  }
}

module.exports = {
  searchFiles
}; 