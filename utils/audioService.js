const axios = require('axios');
const dotenv = require('dotenv').config();
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const crypto = require("crypto");

// Initialize S3 client
const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// Use voice ID from environment variables
const VOICE_ID = process.env.ELEVEN_LABS_VOICE_ID;
if (!VOICE_ID) {
  throw new Error('ELEVEN_LABS_VOICE_ID environment variable is required');
}

const BUCKET_NAME = process.env.AWS_BUCKET_NAME;
const AUDIO_CACHE_DURATION = 24 * 60 * 60; // 24 hours in seconds

async function generateAudioForMessage(text, messageId) {
  try {
    // Generate a unique cache key for this message
    const cacheKey = `audio/${messageId}.mp3`;

    // Check if audio already exists in S3
    try {
      await s3Client.send(
        new GetObjectCommand({
          Bucket: BUCKET_NAME,
          Key: cacheKey,
        })
      );

      // If we get here, the file exists - generate signed URL
      const url = await getSignedUrl(
        s3Client,
        new GetObjectCommand({
          Bucket: BUCKET_NAME,
          Key: cacheKey,
        }),
        { expiresIn: AUDIO_CACHE_DURATION }
      );

      return { url, cached: true };
    } catch (error) {
      // File doesn't exist, generate new audio
      console.log("Generating new audio for message:", messageId);
    }

    // Generate audio using Eleven Labs API
    const response = await axios({
      method: 'POST',
      url: `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': process.env.ELEVEN_LABS_API_KEY
      },
      data: {
        text,
        model_id: "eleven_monolingual_v1",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75
        }
      },
      responseType: 'arraybuffer'
    });

    const audioBuffer = response.data;

    // Upload to S3
    await s3Client.send(
      new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: cacheKey,
        Body: audioBuffer,
        ContentType: 'audio/mpeg',
      })
    );

    // Generate signed URL for the uploaded file
    const url = await getSignedUrl(
      s3Client,
      new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: cacheKey,
      }),
      { expiresIn: AUDIO_CACHE_DURATION }
    );

    return { url, cached: false };
  } catch (error) {
    console.error("Error generating audio:", error);
    throw error;
  }
}

module.exports = {
  generateAudioForMessage,
}; 