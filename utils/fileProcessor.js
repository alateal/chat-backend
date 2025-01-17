require('dotenv').config();
const { OpenAI } = require("openai");
const { OpenAIEmbeddings } = require("@langchain/openai");
const { Pinecone } = require("@pinecone-database/pinecone");
const { RecursiveCharacterTextSplitter } = require("langchain/text_splitter");
const { PDFLoader } = require("langchain/document_loaders/fs/pdf");
const { DocxLoader } = require("langchain/document_loaders/fs/docx");
const { TextLoader } = require("langchain/document_loaders/fs/text");

// Validate required environment variables
if (!process.env.OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY environment variable is required');
}

if (!process.env.PINECONE_API_KEY) {
  throw new Error('PINECONE_API_KEY environment variable is required');
}

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

// Get Pinecone indexes
const chunksIndex = pc.index(process.env.PIGGY_CHUNKS_INDEX || "piggy-chunks");
const summariesIndex = pc.index(process.env.PIGGY_SUMMARIES_INDEX || "piggy-summaries");

// Function to extract text content based on file type
async function extractTextFromFile(filePath, fileType) {
  let loader;
  let text = '';
  
  try {
    switch (fileType) {
      case 'application/pdf':
        const pdfLoader = new PDFLoader(filePath);
        const pdfDocs = await pdfLoader.load();
        text = pdfDocs.map(doc => doc.pageContent).join('\n');
        break;
      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        const docxLoader = new DocxLoader(filePath);
        const docxDocs = await docxLoader.load();
        text = docxDocs.map(doc => doc.pageContent).join('\n');
        break;
      case 'text/plain':
        const textLoader = new TextLoader(filePath);
        const textDocs = await textLoader.load();
        text = textDocs.map(doc => doc.pageContent).join('\n');
        break;
      default:
        throw new Error(`Unsupported file type: ${fileType}`);
    }
    return text;
  } catch (error) {
    console.error(`Error extracting text from ${fileType} file:`, error);
    throw error;
  }
}

// Function to chunk text content
async function chunkText(text) {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
  });

  return await splitter.createDocuments([text]);
}

// Function to generate summary
async function generateSummary(text) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: "Create a concise summary of the following text, highlighting key points and main ideas:"
        },
        { role: "user", content: text }
      ],
      temperature: 0.3,
      max_tokens: 500
    });

    return response.choices[0].message.content;
  } catch (error) {
    console.error("Error generating summary:", error);
    throw error;
  }
}

// Main function to process file
async function processFile(filePath, fileType, fileMetadata) {
  try {
    // Extract text from file
    const text = await extractTextFromFile(filePath, fileType);
    
    // Generate chunks
    const chunks = await chunkText(text);
    
    // Generate summary
    const summary = await generateSummary(text);
    
    // Create embeddings for chunks
    const chunkEmbeddings = await embeddings.embedDocuments(
      chunks.map(chunk => chunk.pageContent)
    );
    
    // Create embedding for summary
    const summaryEmbedding = await embeddings.embedDocuments([summary]);
    
    // Prepare vectors for chunks
    const chunkVectors = chunkEmbeddings.map((embedding, index) => ({
      id: `${fileMetadata.id}-chunk-${index}`,
      values: embedding,
      metadata: {
        fileId: fileMetadata.id,
        fileName: fileMetadata.file_name,
        chunkIndex: index,
        content: chunks[index].pageContent,
        ...fileMetadata
      }
    }));
    
    // Prepare vector for summary
    const summaryVector = {
      id: `${fileMetadata.id}-summary`,
      values: summaryEmbedding[0],
      metadata: {
        fileId: fileMetadata.id,
        fileName: fileMetadata.file_name,
        content: summary,
        type: 'summary',
        ...fileMetadata
      }
    };
    
    // Upload vectors to respective indexes
    await chunksIndex.upsert(chunkVectors);
    await summariesIndex.upsert([summaryVector]);
    
    return {
      chunks: chunks.length,
      summary,
      success: true
    };
  } catch (error) {
    console.error("Error processing file:", error);
    throw error;
  }
}

module.exports = {
  processFile
}; 