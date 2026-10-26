require('dotenv').config();
const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
const client = new MongoClient(MONGODB_URI);

const mockDeveloperId = "65f1a2b3c4d5e6f7a8b9c0d1"; 
const ratios = ["9 / 18", "9 / 19.5", "9 / 20", "9 / 21"];

const appsToSeed = [
  // GAMES
  { name: "Neon Drift", category: "Games", description: "High-speed arcade racing with synthwave style.", price: 14900, icon_url: "https://picsum.photos/seed/neondrift/400/400" },
  { name: "Cosmic Couriers", category: "Games", description: "Deliver packages across a bustling alien solar system.", price: 0, icon_url: "https://picsum.photos/seed/cosmic/400/400" },
  { name: "Pixel Dungeon", category: "Games", description: "A roguelike dungeon crawler with retro 8-bit aesthetics.", price: 4900, icon_url: "https://picsum.photos/seed/pixel/400/400" },
  
  // EDUCATION
  { name: "StudyFlow", category: "Education", description: "Organize notes, tasks and study sessions. Learn better, every day.", price: 0, icon_url: "https://picsum.photos/seed/studyflow/400/400" },
  { name: "MathMentor", category: "Education", description: "Step-by-step math solver for algebra, calculus, and beyond.", price: 9900, icon_url: "https://picsum.photos/seed/math/400/400" },
  { name: "CodeLexicon", category: "Education", description: "Learn to code through interactive bite-sized lessons.", price: 4900, icon_url: "https://picsum.photos/seed/codelex/400/400" },

  // MUSIC
  { name: "BeatLab", category: "Music", description: "Make beats. Layer sounds. Find your groove.", price: 9900, icon_url: "https://picsum.photos/seed/beatlab/400/400" },
  { name: "LoFi Generator", category: "Music", description: "Endless generative lo-fi hip hop tracks to study and relax to.", price: 0, icon_url: "https://picsum.photos/seed/lofi/400/400" },
  { name: "StemSplitter", category: "Music", description: "Separate vocals, drums, and bass from any audio file using AI.", price: 14900, icon_url: "https://picsum.photos/seed/stem/400/400" },

  // UTILITIES
  { name: "QuickCalc", category: "Utilities", description: "Smart, fast calculations at your fingertips. Built for devs and power users.", price: 0, icon_url: "https://picsum.photos/seed/quickcalc/400/400" },
  { name: "FileCompressor", category: "Utilities", description: "Compress images, PDFs, and videos locally without losing quality.", price: 0, icon_url: "https://picsum.photos/seed/compress/400/400" },
  { name: "UnitConverter", category: "Utilities", description: "Convert any unit of measurement across 50+ categories instantly.", price: 4900, icon_url: "https://picsum.photos/seed/unit/400/400" },

  // PRODUCTIVITY
  { name: "FocusTimer", category: "Productivity", description: "Boost focus with Pomodoro sessions and ambient sounds.", price: 0, icon_url: "https://picsum.photos/seed/focus/400/400" },
  { name: "TaskMaster", category: "Productivity", description: "A no-nonsense to-do list for developers. Syncs via API.", price: 4900, icon_url: "https://picsum.photos/seed/tasks/400/400" },
  { name: "NoteTaker", category: "Productivity", description: "Markdown-first note taking with seamless cloud sync.", price: 0, icon_url: "https://picsum.photos/seed/notes/400/400" },

  // CALCULATORS
  { name: "SciCalc Pro", category: "Calculators", description: "Scientific calculator with graphing and matrix math.", price: 4900, icon_url: "https://picsum.photos/seed/scicalc/400/400" },
  { name: "MortgageCalc", category: "Calculators", description: "Plan your bond repayments and interest over 30 years.", price: 0, icon_url: "https://picsum.photos/seed/mortgage/400/400" },

  // TOOLS
  { name: "QRScanner", category: "Tools", description: "Lightning fast, ad-free QR and barcode scanner.", price: 0, icon_url: "https://picsum.photos/seed/qr/400/400" },
  { name: "ColorPicker", category: "Tools", description: "Extract color palettes from your camera or images.", price: 4900, icon_url: "https://picsum.photos/seed/color/400/400" },

  // PHOTOGRAPHY
  { name: "FilmCam", category: "Photography", description: "Retro film camera filters with realistic grain and light leaks.", price: 9900, icon_url: "https://picsum.photos/seed/film/400/400" },
  { name: "LightMeter", category: "Photography", description: "Precise exposure meter for analog and digital photographers.", price: 0, icon_url: "https://picsum.photos/seed/light/400/400" },

  // HEALTH
  { name: "WaterTracker", category: "Health", description: "Stay hydrated with smart reminders and daily goal tracking.", price: 0, icon_url: "https://picsum.photos/seed/water/400/400" },
  { name: "SleepSync", category: "Health", description: "Analyze your sleep cycles and wake up at the perfect time.", price: 4900, icon_url: "https://picsum.photos/seed/sleep/400/400" },

  // DEVELOPER TOOLS
  { name: "RegexTester", category: "Developer Tools", description: "Test and debug regular expressions with live syntax highlighting.", price: 0, icon_url: "https://picsum.photos/seed/regex/400/400" },
  { name: "API Mock", category: "Developer Tools", description: "Instantly spin up mock REST endpoints for frontend testing.", price: 9900, icon_url: "https://picsum.photos/seed/api/400/400" },
  { name: "GitCheat", category: "Developer Tools", description: "The ultimate cheat sheet for Git commands and workflows.", price: 0, icon_url: "https://picsum.photos/seed/git/400/400" },

  // CREATIVE & DESIGN
  { name: "GenArt", category: "Creative & Design", description: "Generate unique abstract art using text prompts.", price: 14900, icon_url: "https://picsum.photos/seed/genart/400/400" },
  { name: "Palettr", category: "Creative & Design", description: "Find the perfect color combinations for your UI projects.", price: 0, icon_url: "https://picsum.photos/seed/palette/400/400" },

  // LIFESTYLE & WELLNESS
  { name: "HabitLoop", category: "Lifestyle & Wellness", description: "Build better habits with visual streak tracking.", price: 4900, icon_url: "https://picsum.photos/seed/habit/400/400" },
  { name: "Journal", category: "Lifestyle & Wellness", description: "A private, encrypted daily journal for mindfulness.", price: 0, icon_url: "https://picsum.photos/seed/journal/400/400" },

  // FINANCE
  { name: "CryptoWatch", category: "Finance", description: "Track your favorite cryptocurrencies with custom alerts.", price: 0, icon_url: "https://picsum.photos/seed/crypto/400/400" },
  { name: "SubTracker", category: "Finance", description: "Manage all your recurring subscriptions in one dashboard.", price: 4900, icon_url: "https://picsum.photos/seed/subs/400/400" },

  // SOCIAL & NICHE
  { name: "BookClub", category: "Social & Niche", description: "Join virtual book clubs and track your reading progress.", price: 0, icon_url: "https://picsum.photos/seed/book/400/400" },
  { name: "LangSwap", category: "Social & Niche", description: "Learn a new language by chatting with native speakers.", price: 9900, icon_url: "https://picsum.photos/seed/lang/400/400" }
];

async function seedDatabase() {
  try {
    await client.connect();
    console.log('✅ Connected to MongoDB Atlas');
    
    const db = client.db('flipstack');
    const apps = db.collection('apps');

    console.log('🗑️  Clearing existing apps collection...');
    await apps.deleteMany({});

    // Prepare the documents with the required schema fields and varying aspect ratios
    const finalApps = appsToSeed.map((app, index) => ({
      ...app,
      developerId: mockDeveloperId,
      app_id: `${app.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${index}`,
      paystack_secret: "sk_test_mock_secret_for_storefront",
      aspect_ratio: ratios[index % ratios.length], // Randomly cycles through the 4 ratios
      created_at: new Date()
    }));

    console.log(`🌱 Injecting ${finalApps.length} mock apps with variable aspect ratios...`);
    await apps.insertMany(finalApps);
    
    console.log('✅ Seeding complete! Storefront is ready for the Peacock Tail.');
  } catch (err) {
    console.error('❌ Seeding failed:', err);
  } finally {
    await client.close();
    process.exit(0);
  }
}

seedDatabase();
