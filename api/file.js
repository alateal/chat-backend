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
  router.post("/upload", upload.single("file"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file provided" });
      }

      const fileId = crypto.randomBytes(16).toString("hex");
      const fileExtension = req.file.originalname.split(".").pop();
      const key = `uploads/${fileId}.${fileExtension}`;

      const command = new PutObjectCommand({
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
        ACL: "public-read",
      });

      await s3Client.send(command);

      const fileUrl = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;

      res.json({
        id: fileId,
        file_name: req.file.originalname,
        file_url: fileUrl,
        file_type: req.file.mimetype,
        file_size: req.file.size,
      });
    } catch (error) {
      console.error("File upload error:", error);
      res.status(500).json({ error: "Upload failed" });
    }
  });

  return router;
};
