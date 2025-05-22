// server.js
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const mongoose = require("mongoose");
const axios = require("axios");
const cloudinary = require("cloudinary").v2;
const { v4: uuidv4 } = require("uuid");
const fs = require("fs/promises");
const path = require("path");

dotenv.config();
const app = express();
const allowedOrigins = [
  'https://pfp-zule.vercel.app',
  'https://pfp.zuleai.xyz'
];

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like curl, Postman)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = `The CORS policy for this site does not allow access from the specified Origin: ${origin}`;
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  }
}));

app.use(express.json());

// MongoDB connection
mongoose.connect(process.env.MONGO_URI, {

}).then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.error("❌ MongoDB Error:", err));

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Mongoose schema
const GalleryItemSchema = new mongoose.Schema({
  id: Number,
  username: String,
  inscription: String,
  imageUrl: String,
});
const GalleryItem = mongoose.model("GalleryItem", GalleryItemSchema);

// Image generation and saving route
app.post("/api/generate-image", async (req, res) => {
  const { username, inscription, hatColor, gender, description, customColor } = req.body;

  const prompt = `
    Create a cartoon-style profile picture (PFP) for a user.
    - Username: ${username}
    - Inscription: ${inscription}
    - Hat color: ${hatColor || "default"}
    - Gender: ${gender || "neutral"}
    - Theme color: ${customColor || "#5CEFFF"}
    - Description: ${description || "A crypto raider repping ZULE"}
    Make it stylish and digitally aesthetic.
  `;

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  const MODEL_ID = 'models/imagen-3.0-generate-002';

  const payload = {
    instances: [{ prompt }],
    parameters: {
      sampleCount: 1,
      personGeneration: 'ALLOW_ADULT',
      aspectRatio: '1:1',
    },
  };

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/${MODEL_ID}:predict?key=${GEMINI_API_KEY}`,
      payload,
      { headers: { 'Content-Type': 'application/json' } }
    );

    const base64Data = response.data?.predictions?.[0]?.bytesBase64Encoded;
    if (!base64Data) {
      return res.status(500).json({ error: "No image returned from Gemini." });
    }

    // Save image temporarily
    const buffer = Buffer.from(base64Data, 'base64');
    const fileName = `generated_image_${uuidv4()}.png`;
    const filePath = path.join(__dirname, fileName);
    await fs.writeFile(filePath, buffer);

    // Upload to Cloudinary
    const uploadResult = await cloudinary.uploader.upload(filePath, {
      folder: "zule-pfps",
      public_id: path.parse(fileName).name,
    });

    // Cleanup temp file
    await fs.unlink(filePath);

    // Save to MongoDB
    const lastItem = await GalleryItem.findOne().sort({ id: -1 });
    const nextId = lastItem ? lastItem.id + 1 : 1;

    const newItem = await GalleryItem.create({
      id: nextId,
      username,
      inscription,
      imageUrl: uploadResult.secure_url,
    });

    res.json({
      imageUrl: uploadResult.secure_url,
      message: "Image generated and saved.",
      galleryItem: newItem,
    });
  } catch (err) {
    console.error("❌ Error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to generate or save image." });
  }
});

// Root endpoint
app.get("/", (req, res) => {
    console.log("API accessed");
    // Log the request method and URL
  res.send("Welcome to the ZULE PFP image generation API!");
});

// Get community gallery

app.get("/api/gallery", async (req, res) => {
  try {
    // Get page and limit from query params, default to page 1 and limit 5
    const page = parseInt(req.query.page) || 1;
    const limit = 5;
    const skip = (page - 1) * limit;

    // Get total count of gallery items
    const total = await GalleryItem.countDocuments();

    // Get paginated items sorted by id descending
    const items = await GalleryItem.find()
      .sort({ id: -1 })
      .skip(skip)
      .limit(limit);

    res.json({ total, items });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch gallery." });
  }
});


const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 API running on http://localhost:${PORT}`);
});
