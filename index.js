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



// Initialize API keys from environment variables
const geminiApiKeys = [];
let keyIndex = 1;
while (process.env[`GEMINI_API_KEY_${keyIndex}`]) {
  geminiApiKeys.push(process.env[`GEMINI_API_KEY_${keyIndex}`]);
  keyIndex++;
}

let currentApiKeyIndex = 0; // Keeps track of the current Gemini API key in use
let geminiApiKey = geminiApiKeys[currentApiKeyIndex];
let currentApiKeyName = `GEMINI_API_KEY_${currentApiKeyIndex + 1}`;

// Function to get the next API key (circular rotation)
function getNextApiKey() {
  currentApiKeyIndex = (currentApiKeyIndex + 1) % geminiApiKeys.length;
  geminiApiKey = geminiApiKeys[currentApiKeyIndex];
  currentApiKeyName = `GEMINI_API_KEY_${currentApiKeyIndex + 1}`;
  return geminiApiKey;
}

// Function to generate the image with recursive retry logic
async function generateImage(prompt, retries, maxRetries) {
  retries = retries || 0;
  maxRetries = maxRetries || geminiApiKeys.length * 2;
  const MODEL_ID = "models/imagen-3.0-generate-002";

  if (!geminiApiKey) {
    console.error("No Gemini API key available.");
    throw new Error("No API key available.");
  }

  if (retries >= maxRetries) {
    console.error("Max retries reached. Unable to generate image.");
    throw new Error("Max retries reached. Unable to generate image.");
  }

  try {
    console.info(`Using ${currentApiKeyName} to generate image...`);

    const payload = {
      instances: [{ prompt: prompt }],
      parameters: {
        sampleCount: 1,
        personGeneration: "ALLOW_ADULT",
        aspectRatio: "1:1",
      },
    };

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/${MODEL_ID}:predict?key=${geminiApiKey}`,
      payload,
      { headers: { "Content-Type": "application/json" } }
    );

    const base64Data = response.data?.predictions?.[0]?.bytesBase64Encoded;
    if (!base64Data) {
      throw new Error("No image returned from Gemini.");
    }

    return Buffer.from(base64Data, "base64");

  } catch (error) {
    if (error.response && error.response.status === 429) {
      console.error(`---${currentApiKeyName} limit exhausted (429), switching to the next API key...`);
      getNextApiKey();
      await new Promise(resolve => setTimeout(resolve, 1000)); // 1-second delay
      return generateImage(prompt, retries + 1, maxRetries);
    } else if (error.response && error.response.status === 503) {
      console.error(`Service unavailable (503) with ${currentApiKeyName}. Retrying after delay...`);
      await new Promise(resolve => setTimeout(resolve, 5000)); // 5-second delay
      getNextApiKey();
      return generateImage(prompt, retries + 1, maxRetries);
    } else {
      console.error(`Error generating image with ${currentApiKeyName}: ${error.message}`);
      throw error;
    }
  }
}

// Function to apply watermark (with 2x size increase)
async function applyWatermark(imagePath, logoPath, outputPath) {
  const image = sharp(imagePath);
  const { width, height } = await image.metadata();
  const logo = sharp(logoPath);
  const logoMetadata = await logo.metadata();

  const maxLogoWidth = 100; // Doubled from 50 to 100 (2x)
  const targetLogoWidth = Math.min(Math.round(width * 0.4), maxLogoWidth); // Already adjusted to 0.4 (2x from 0.2)
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
    .toFile(outputPath);

  return outputPath;
}

// Express route for generating the image
app.post("/api/generate-image", async (req, res) => {
  const { username, inscription, hatColor, gender, description, customColor } = req.body;

  const prompt = `
Stylized Cartoon Avatar Featuring a Trucker Hat with a Custom Inscription

Overview:
Generate a high-quality, digitally aesthetic profile picture (PFP) of a stylized cartoon avatar, wearing a trucker hat that prominently displays the inscription "${inscription}". The avatar must embody a modern, vibrant cartoon stylization with a playful vibe, avoiding any hyper-realistic human features. Incorporate the following personalized attributes:
- Hat Inscription: "${inscription}"
- Hat Color: ${hatColor}
- Gender: ${gender}
- Description: ${description}

Avatar Specifications:

Art Style: Stylized cartoon avatar with vibrant colors, bold outlines, and exaggerated features typical of high-quality cartoon PFPs (e.g., similar to modern NFT avatars or anime-inspired characters). The avatar must have a distinctly animated, non-human appearance with clean lines, simplified textures, and a whimsical vibe suitable for a lighthearted audience.

Expression: Shy and slightly embarrassed, featuring a small, closed-mouth smile, wide eyes with a hint of nervousness, and cartoon-style sweat drops near the face to convey a playful, apologetic mood.

Eyes: Large, stylized black eyes with thick outlines, bold white highlights, and a shiny, animated look to emphasize the cartoon aesthetic. Add a slight til t to the eyes to enhance the shy expression.

Hair: Medium-length, stylized black hair tied into two pigtails, with a smooth, playful design that enhances the cartoon style, using bold highlights and simplified shading. The pigtails should be symmetrical and slightly voluminous.

Skin Tone: Pale complexion with smooth, vibrant cartoon shading (e.g., flat colors with subtle gradients), featuring cartoon-style sweat drops and a small cross-shaped mark on the cheek for a quirky, playful appearance.

Clothing: Modern, dark-colored collared shirt (e.g., black) in a simplified cartoon design with bold outlines, minimal texture details, and a casual look tailored for a whimsical, approachable character.

Accessories:
- Hat: Trucker-style cap in ${hatColor}, featuring a mesh back and a prominent front panel. The inscription "${inscription}" must be displayed in its entirety on the front panel in a bold, legible, black font. Ensure the text is clear, undistorted, and fully visible, occupying the majority of the front panel without truncation or distortion.
- Safety Pin: A cartoon-style safety pin accessory on the side of the head, near one of the pigtails, with a simplified design and bold outlines to enhance the quirky aesthetic.

Background:
- Solid black backdrop with minimal digital glitch effects and faint, floating pixel particles in soft sky-blue (#5CEFFF) tones to evoke a modern, digital aesthetic.
- Ensure the background remains understated, keeping the avatar as the focal point without distracting from the character or hat.

Critical Requirements:
- The avatar must be a stylized cartoon with exaggerated, animated features (e.g., large eyes, bold outlines, vibrant colors), explicitly avoiding any hyper-realistic human traits such as photorealistic skin textures or lifelike proportions.
- Use a style similar to modern NFT avatars or anime-inspired characters to ensure a distinctly cartoonish appearance.
- The hat inscription must exactly match "${inscription}", displayed prominently and legibly on the trucker hat’s front panel with no truncation, distortion, or partial rendering.
- Exclude any additional logos, characters, or text beyond the specified inscription.
- Ensure the composition prioritizes the avatar’s face and hat, with the background enhancing but not overpowering the subject.
`.trim();

  let filePath, watermarkedFilePath;

  try {
    // Generate the image using the recursive function
    const imageBuffer = await generateImage(prompt);

    // Save the generated image
    const fileName = `generated_image_${uuidv4()}.png`;
    filePath = path.join(__dirname, fileName);
    await fs.writeFile(filePath, imageBuffer);

    // Apply watermark
    const logoPath = path.join(__dirname, "watermark_logo.png");
    const watermarkedFileName = `watermarked_${fileName}`;
    watermarkedFilePath = path.join(__dirname, watermarkedFileName);

    try {
      await fs.access(logoPath);
    } catch (err) {
      console.error("❌ Logo file not found:", logoPath);
      await fs.unlink(filePath).catch(() => {});
      return res.status(500).json({ error: "Logo file not found." });
    }

    await applyWatermark(filePath, logoPath, watermarkedFilePath);

    // Upload to Cloudinary
    const uploadResult = await cloudinary.uploader.upload(watermarkedFilePath, {
      folder: "zule-pfps",
      public_id: path.parse(watermarkedFileName).name,
    });

    // Clean up local files
    try {
      await fs.unlink(filePath);
      await fs.unlink(watermarkedFilePath);
    } catch (cleanupErr) {
      console.error("❌ Cleanup Error:", cleanupErr.message);
    }

    // Save to database
    const lastItem = await GalleryItem.findOne().sort({ id: -1 });
    const nextId = lastItem ? lastItem.id + 1 : 1;

    const newItem = await GalleryItem.create({
      id: nextId,
      username: username,
      inscription: inscription,
      imageUrl: uploadResult.secure_url,
    });

    res.json({
      imageUrl: uploadResult.secure_url,
      message: "Image generated, watermarked, and saved.",
      galleryItem: newItem,
    });

  } catch (err) {
    console.error("❌ Error:", err.message);
    try {
      if (filePath) await fs.unlink(filePath);
      if (watermarkedFilePath) await fs.unlink(watermarkedFilePath);
    } catch (cleanupErr) {
      console.error("❌ Cleanup Error:", cleanupErr.message);
    }
    res.status(500).json({ error: "Failed to generate, watermark, or save image." });
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
    const limit = 10
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
