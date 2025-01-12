const express = require("express");
const router = express.Router();
const multer = require("multer");
const crypto = require("crypto");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

// Initialize S3 client
const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// Configure multer for file upload
const upload = multer({
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
});

module.exports = function () {
  // File upload endpoint
  router.post("/upload"),
    upload.single("file"),
    async (req, res) => {
      try {
        if (!req.file) {
          return res.status(400).json({ error: "No file uploaded" });
        }

        const { userId } = req.auth;
        const file = req.file;

        // Generate unique filename and ID
        const fileId = crypto.randomBytes(16).toString("hex");
        const fileExtension = file.originalname.split(".").pop();
        const fileName = `${fileId}.${fileExtension}`;

        // Upload to S3
        const uploadParams = {
          Bucket: process.env.AWS_BUCKET_NAME,
          Key: fileName,
          Body: file.buffer,
          ContentType: file.mimetype,
        };

        await s3Client.send(new PutObjectCommand(uploadParams));

        // Return file metadata to be stored in message's file_attachments
        const fileMetadata = {
          id: fileId,
          file_name: file.originalname,
          file_type: file.mimetype,
          file_size: file.size,
          file_url: `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileName}`,
        };

        res.json(fileMetadata);
      } catch (error) {
        console.error("Detailed upload error:", error);
        res.status(500).json({
          error: "Error uploading file",
          details: error.message,
        });
      }
    };
  return router;
};
