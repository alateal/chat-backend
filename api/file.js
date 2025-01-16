const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

// Initialize S3 client
const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

module.exports = function () {
  // Get presigned URL endpoint
  router.post("/upload", async (req, res) => {
    try {
      // Validate required fields
      if (!req.body.fileName || !req.body.fileType) {
        return res.status(400).json({ error: "fileName and fileType are required" });
      }

      // Validate AWS configuration
      if (!process.env.AWS_BUCKET_NAME || !process.env.AWS_REGION) {
        console.error('Missing AWS configuration');
        return res.status(500).json({ error: "Server configuration error" });
      }

      const fileId = crypto.randomBytes(16).toString("hex");
      const fileExtension = req.body.fileName.split(".").pop();
      const key = `uploads/${fileId}.${fileExtension}`;

      // Create the presigned URL command
      const command = new PutObjectCommand({
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: key,
        ContentType: req.body.fileType,
        ACL: "public-read",
      });

      // Generate presigned URL that expires in 15 minutes
      const presignedUrl = await getSignedUrl(s3Client, command, { expiresIn: 900 });

      const response = {
        uploadUrl: presignedUrl,
        fileUrl: `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`,
        fileId: fileId
      };

      res.json(response);
    } catch (error) {
      console.error('Error generating presigned URL:', error);
      res.status(500).json({ 
        error: "Failed to generate upload URL", 
        details: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  return router;
};
