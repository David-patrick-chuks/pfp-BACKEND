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
const sharp = require("sharp");

dotenv.config();
const app = express();
const allowedOrigins = [
  "https://pfp-zule.vercel.app",
  "https://pfp.zuleai.xyz",
  "https://www.zuleai.xyz",
  "https://zuleai.xyz",
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.indexOf(origin) === -1) {
        const msg = `The CORS policy for this site does not allow access from the specified Origin: ${origin}`;
        return callback(new Error(msg), false);
      }
      return callback(null, true);
    },
  })
);

app.use(express.json());

// MongoDB connection
mongoose
  .connect(process.env.MONGO_URI, {})
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.error("❌ MongoDB Error:", err));

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Mongoose schemas
const GalleryItemSchema = new mongoose.Schema({
  id: Number,
  username: String,
  inscription: String,
  imageUrl: String,
});
const GalleryItem = mongoose.model("GalleryItem", GalleryItemSchema);

// Newsletter subscription schema
const NewsletterSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true, // Prevent duplicate emails
    trim: true,
    lowercase: true,
    match: [/^\S+@\S+\.\S+$/, "Please enter a valid email address"], // Basic email validation
  },
  subscribedAt: {
    type: Date,
    default: Date.now,
  },
});
const Newsletter = mongoose.model("Newsletter", NewsletterSchema);

// Image generation and saving route
app.post("/api/generate-image", async (req, res) => {
  const { username, inscription, hatColor, gender, description, customColor } =
    req.body;

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
  const MODEL_ID = "models/imagen-3.0-generate-002";

  const payload = {
    instances: [{ prompt }],
    parameters: {
      sampleCount: 1,
      personGeneration: "ALLOW_ADULT",
      aspectRatio: "1:1",
    },
  };

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/${MODEL_ID}:predict?key=${GEMINI_API_KEY}`,
      payload,
      { headers: { "Content-Type": "application/json" } }
    );

    const base64Data = response.data?.predictions?.[0]?.bytesBase64Encoded;
    if (!base64Data) {
      return res.status(500).json({ error: "No image returned from Gemini." });
    }

    const buffer = Buffer.from(base64Data, "base64");
    const fileName = `generated_image_${uuidv4()}.png`;
    const filePath = path.join(__dirname, fileName);
    await fs.writeFile(filePath, buffer);

    const logoPath = path.join(__dirname, "watermark_logo.png");
    const watermarkedFileName = `watermarked_${fileName}`;
    const watermarkedFilePath = path.join(__dirname, watermarkedFileName);

    try {
      await fs.access(logoPath);
    } catch (err) {
      console.error("❌ Logo file not found:", logoPath);
      await fs.unlink(filePath).catch(() => {});
      return res.status(500).json({ error: "Logo file not found." });
    }

    const image = sharp(filePath);
    const { width, height } = await image.metadata();
    const logo = sharp(logoPath);
    const logoMetadata = await logo.metadata();

    const maxLogoWidth = 50;
    const targetLogoWidth = Math.min(Math.round(width * 0.1), maxLogoWidth);
    const targetLogoHeight = Math.round(
      (targetLogoWidth / logoMetadata.width) * logoMetadata.height
    );

    const resizedLogo = await logo
      .resize(targetLogoWidth, targetLogoHeight, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .toBuffer();

    const padding = 10;
    await image
      .composite([
        {
          input: resizedLogo,
          top: padding,
          left: Math.max(0, width - targetLogoWidth - padding),
          blend: "over",
          opacity: 0.7,
        },
      ])
      .toFile(watermarkedFilePath);

    const uploadResult = await cloudinary.uploader.upload(watermarkedFilePath, {
      folder: "zule-pfps",
      public_id: path.parse(watermarkedFileName).name,
    });

    try {
      await fs.unlink(filePath);
      await fs.unlink(watermarkedFilePath);
    } catch (cleanupErr) {
      console.error("❌ Cleanup Error:", cleanupErr.message);
    }

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
      message: "Image generated, watermarked, and saved.",
      galleryItem: newItem,
    });
  } catch (err) {
    console.error("❌ Error:", err.response?.data || err.message);
    try {
      await fs.unlink(filePath).catch(() => {});
      await fs.unlink(watermarkedFilePath).catch(() => {});
    } catch (cleanupErr) {
      console.error("❌ Cleanup Error:", cleanupErr.message);
    }
    res
      .status(500)
      .json({ error: "Failed to generate, watermark, or save image." });
  }
});

// Newsletter subscription route
app.post("/api/newsletter", async (req, res) => {
  const { email } = req.body;

  // Basic validation
  if (!email) {
    return res.status(400).json({ error: "Email is required." });
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return res
      .status(400)
      .json({ error: "Please enter a valid email address." });
  }

  try {
    // Check if email already exists
    const existingSubscription = await Newsletter.findOne({
      email: email.toLowerCase(),
    });
    if (existingSubscription) {
      return res
        .status(409)
        .json({ error: "This email is already subscribed." });
    }

    // Create new subscription
    const newSubscription = await Newsletter.create({ email });
    res
      .status(201)
      .json({ message: "Successfully subscribed to the newsletter!" });
  } catch (err) {
    console.error("❌ Newsletter Error:", err.message);
    res.status(500).json({ error: "Failed to subscribe. Please try again." });
  }
});

// Root endpoint
app.get("/", (req, res) => {
  console.log("API accessed");
  res.send("Welcome to the ZULE PFP image generation API!");
});

// Get community gallery
app.get("/api/gallery", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 10;
    const skip = (page - 1) * limit;

    const total = await GalleryItem.countDocuments();
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
