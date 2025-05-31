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
  "https://pfp.zuleai.xyz",
  "https://www.zuleai.xyz",
  "https://zuleai.xyz",
  "https://pfp.zuleai.xyz/",
  "https://pfp-gbxgpnv6c-david-patricks-projects.vercel.app",
  "https://pfp-zule.vercel.app"
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

// Function to shuffle an array (Fisher-Yates shuffle)
function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]]; // Swap elements
  }
  return array;
}

// Initialize API keys from environment variables
const geminiApiKeys = [];
let keyIndex = 1;
while (process.env[`GEMINI_API_KEY_${keyIndex}`]) {
  geminiApiKeys.push(process.env[`GEMINI_API_KEY_${keyIndex}`]);
  keyIndex++;
}

// Shuffle the API keys array to start with a random key
const shuffledApiKeys = shuffleArray([...geminiApiKeys]); // Create a copy and shuffle
let currentApiKeyIndex = 0; // Keeps track of the current Gemini API key in use
let geminiApiKey = shuffledApiKeys[currentApiKeyIndex];
let currentApiKeyName = `GEMINI_API_KEY_${geminiApiKeys.indexOf(geminiApiKey) + 1}`;

// Function to get the next API key (circular rotation)
function getNextApiKey() {
  currentApiKeyIndex = (currentApiKeyIndex + 1) % geminiApiKeys.length;
  geminiApiKey = geminiApiKeys[currentApiKeyIndex];
  currentApiKeyName = `GEMINI_API_KEY_${currentApiKeyIndex + 1}`;
  return geminiApiKey;
}

// Function to generate the image with recursive retry logic
async function generateImage(prompt, retries = 0, maxRetries = geminiApiKeys.length * 2) {
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
      console.error(`No image returned from Gemini with ${currentApiKeyName}. Retrying...`);
      getNextApiKey();
      await new Promise(resolve => setTimeout(resolve, 1000)); // 1-second delay
      return generateImage(prompt, retries + 1, maxRetries);
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
      getNextApiKey();
      await new Promise(resolve => setTimeout(resolve, 1000)); // 1-second delay
      return generateImage(prompt, retries + 1, maxRetries);
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
  const { username, traits } = req.body; // Collect JSON traits from client

  // Validate traits input
  if (!traits || !Array.isArray(traits)) {
    return res.status(400).json({ error: "Invalid or missing traits array." });
  }

  // Construct the prompt from traits
  let prompt = `
You are an AI art generator specializing in creating digital characters in the style of Milady and Remilio NFTs. These characters are chibi-style with a blocky, low-poly, hand-drawn sketch aesthetic, featuring large expressive anime-like eyes, simple facial features, and a prominent retro glitch effect. The style should resemble a rough, artist sketch with visible pencil or digital sketch lines, avoiding smooth 3D renders or polished cartoon looks. Use vibrant colors, exaggerated accessories, and a mix of cute and edgy traits. Your task is to generate a character based on the following JSON traits, ensuring each trait is accurately represented with the Milady/Remilio sketch aesthetic.

1. **Base Character Design:**
   - Create a chibi-style character with a blocky, low-poly body and a large head, drawn with rough sketch lines.
   - Use large, shiny anime-style eyes with small pupils, simple eyebrows, and a minimalistic mouth (e.g., a small line or shape), all with a sketch-like texture.
   - Apply a strong retro glitch effect and pixelated texture to the entire image, mimicking a corrupted digital sketch.
   - The skin tone should match the "skin" or "Race" trait value (e.g., "tan"), rendered with sketch shading.
   - The overall aesthetic should be cute yet slightly rebellious, with a hand-drawn, unfinished look.

2. **Interpret JSON Traits:**
   - Parse the JSON input to extract each trait and its corresponding value.
   - Apply each trait to the character design as follows:
     - **Background:** Set the background scene (e.g., "roadside" should depict a road with a horizon and some roadside elements like signs or grass, drawn with sketch lines and glitch effects).
     - **Race/Skin:** Adjust the character's skin tone (e.g., "tan" for a medium tan shade, with sketch shading).
     - **Hat:** Add the specified hat (e.g., "Alien Hat" should be a quirky, sci-fi-themed hat with antennae or glowing elements, drawn as a blocky sketch).
     - **Glasses:** Include the specified glasses (e.g., "Harajuku Glasses" should be colorful, oversized, and trendy, with a sketchy design).
     - **Face:** Apply the facial expression or style (e.g., "big blush" adds large pink blush marks on the cheeks, drawn with rough lines).
     - **Eyes:** Modify the eye shape (e.g., "Dilated" means larger pupils with a slightly dazed look, sketch-style).
     - **Eye color:** Set the eye color (e.g., "Brown" for brown eyes, with sketch shading).
     - **Necklace:** Add the necklace (e.g., "evil eye necklace" should be a blue and white amulet on a chain, drawn as a blocky sketch).
     - **Shirt:** Dress the character in the specified shirt (e.g., "cardigan tee" is a casual tee with a cardigan over it, low-poly and sketch-like).
     - **Hair:** Style the hair (e.g., "og frosted blonde" should be a blonde afro with frosted tips, drawn with blocky, sketch lines).
     - **Eyebrows/Brows:** Adjust the eyebrows (e.g., "concernedb" for concerned eyebrows, "flat" for straight, neutral brows, sketch-style).
     - **Mouth:** Set the mouth expression (e.g., "smilec" for a small, cute smile, drawn with rough lines).
     - **Weapon:** Include the weapon as an accessory (e.g., "Super Soaker" is a colorful water gun held in hand, blocky and sketch-like).
     - **Costume:** If a costume is specified, overlay it on the character (e.g., "Nun" adds a nun's habit over the existing outfit, low-poly sketch).
     - **Earring:** Add the earring (e.g., "dual rings silver" means two silver hoop earrings, drawn as a blocky sketch).
     - **Neck:** Add neck details (e.g., "Lean Neck Tattoo" adds a small, edgy tattoo on the neck, sketch-style).
     - **Face Decoration:** Include facial details (e.g., "star heart tattoo" adds a small star and heart tattoo on the face, drawn with rough lines).
     - **Core:** Reflect the core style in the overall vibe (e.g., "harajuku" emphasizes bright colors and trendy accessories, sketch-like).
     - **Drip Score/Drip Grade:** Use these to influence the overall "coolness" factor (e.g., "42" and "s-drip" mean the character should look very stylish and high-fashion, with sketch emphasis).

3. **Styling and Details:**
   - Ensure the character's outfit and accessories align with the "Core" trait (e.g., "harajuku" style should be vibrant and eclectic, drawn with sketch lines).
   - Use bold, contrasting colors with a hand-drawn, sketch-like texture for clothing and accessories.
   - Add small details to enhance the personality (e.g., a mischievous glint in the eyes for an "s-drip" character, rendered as a sketch).
   - Maintain the retro glitch effect and sketch-like quality throughout all elements.

4. **Background and Composition:**
   - Place the character in the specified background (e.g., "roadside" with a road, sky, and distant buildings, drawn with sketch lines and glitch effects).
   - Ensure the background complements the character without overpowering them, keeping the sketch aesthetic.
   - Apply a retro glitch effect and pixelated texture to the background.

5. **Final Touches:**
   - Apply a subtle watermark in the bottom corner with "MAKER.REMILIA.ORG", drawn with sketch lines.
   - If the JSON includes a "Drip Grade" like "s-drip," add a small badge or text in the corner saying "UNREGISTERED HYPERCAM 2" in a pixelated, sketch-style font.

**JSON Traits Input:**
${JSON.stringify(traits, null, 2)}

**Output:**
Generate a digital image of the character with all traits applied, ensuring the style matches the Milady and Remilio aesthetic with a blocky, low-poly, hand-drawn sketch design and a strong retro glitch effect. Avoid smooth 3D renders or polished cartoon looks; focus on a rough, artist sketch vibe. Do not describe the image in text; only produce the visual output.
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

    // const newItem = await GalleryItem.create({
    //   id: nextId,
    //   username: username,
    //   inscription: traits.find(t => t.trait_type === "hat" || t.trait_type === "Hat")?.value || "Custom",
    //   imageUrl: uploadResult.secure_url,
    // });

    res.json({
      imageUrl: uploadResult.secure_url,
      message: "Image generated, watermarked, and saved.",
      // galleryItem: newItem,
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
    const limit = 10;
    const skip = (page - 1) * limit;

    // Use aggregation to remove duplicates based on username
    const total = await GalleryItem.aggregate([
      { $match: { username: { $exists: true, $ne: null } } }, // Ensure username exists
      { $group: { _id: "$username", count: { $sum: 1 } } }, // Group by username
      { $count: "total" }, // Count unique usernames
    ]).then(result => result[0]?.total || 0); // Extract total or default to 0

    // Fetch unique items, keeping the first occurrence of each username
    const items = await GalleryItem.aggregate([
      { $match: { username: { $exists: true, $ne: null } } }, // Ensure username exists
      { $sort: { id: -1 } }, // Sort by id descending
      { $group: { 
          _id: "$username", 
          doc: { $first: "$$ROOT" } // Keep the first document for each username
        }
      },
      { $replaceRoot: { newRoot: "$doc" } }, // Replace root with the document
      { $sort: { id: -1 } }, // Re-sort by id after grouping
      { $skip: skip }, // Apply pagination
      { $limit: limit }, // Limit results
    ]);

    res.json({ total, items });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch gallery." });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 API running on http://localhost:${PORT}`);
});
