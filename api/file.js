const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { processFile } = require('../utils/fileProcessor');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

// Initialize S3 client
const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// Helper function to download file from URL
async function downloadFile(url, filePath) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download: ${response.statusCode}`));
        return;
      }

      const writeStream = fs.createWriteStream(filePath);
      response.pipe(writeStream);

      writeStream.on('finish', () => {
        writeStream.close();
        resolve();
      });

      writeStream.on('error', reject);
    }).on('error', reject);
  });
}

module.exports = function () {
  router.post("/upload", async (req, res) => {
    try {
      if (!req.body.fileName || !req.body.fileType) {
        return res.status(400).json({ error: "fileName and fileType are required" });
      }

      if (!process.env.AWS_BUCKET_NAME || !process.env.AWS_REGION) {
        console.error('Missing AWS configuration');
        return res.status(500).json({ error: "Server configuration error" });
      }

      const fileId = crypto.randomBytes(16).toString("hex");
      const fileExtension = req.body.fileName.split(".").pop();
      const key = `uploads/${fileId}.${fileExtension}`;

      // Create temporary file path for processing
      const tempFilePath = path.join(os.tmpdir(), `${fileId}.${fileExtension}`);
      
      const command = new PutObjectCommand({
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: key,
        ContentType: req.body.fileType,
        ACL: "public-read",
      });

      const presignedUrl = await getSignedUrl(s3Client, command, { expiresIn: 900 });
      const fileUrl = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;

      const fileMetadata = {
        id: fileId,
        file_name: req.body.fileName,
        file_type: req.body.fileType,
        file_url: fileUrl,
        uploaded_by: req.auth.userId,
        upload_date: new Date().toISOString()
      };

      // Set up a timeout to process the file after it's uploaded
      if (['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain']
          .includes(req.body.fileType)) {
        
        setTimeout(async () => {
          try {
            // Wait for file to be available
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Download the file from S3
            await downloadFile(fileUrl, tempFilePath);
            console.log('File downloaded successfully');

            // Process the file
            const result = await processFile(tempFilePath, req.body.fileType, fileMetadata);
            console.log('File processed successfully:', result);

            // Clean up temp file
            fs.unlink(tempFilePath, err => {
              if (err) console.error('Error deleting temp file:', err);
            });
          } catch (error) {
            console.error('Error in delayed file processing:', error);
            fs.unlink(tempFilePath, err => {
              if (err) console.error('Error deleting temp file:', err);
            });
          }
        }, 5000); // Wait 5 seconds for upload to complete
      }

      const response = {
        uploadUrl: presignedUrl,
        fileUrl,
        fileId
      };

      res.json(response);
    } catch (error) {
      console.error('Error handling file upload:', error);
      res.status(500).json({ 
        error: "Failed to handle file upload", 
        details: error.message
      });
    }
  });

  return router;
};
