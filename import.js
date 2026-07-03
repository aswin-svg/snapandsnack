const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

// Read your blog.json
const db = JSON.parse(fs.readFileSync(path.join(__dirname, 'blog.json'), 'utf-8'));

// Connect to MongoDB
mongoose.connect('mongodb+srv://aswin:Aswin2024@snapandsnack.u6op5mg.mongodb.net/snapandsnacks?retryWrites=true&w=majority&appName=snapandsnack', {
  serverSelectionTimeoutMS: 30000,
  socketTimeoutMS: 45000,
})
  .then(() => console.log('Connected to MongoDB!'))
  .catch(err => console.error('Connection error:', err));

// Schemas
const PostSchema = new mongoose.Schema({
  id: Number, title: String, content: String,
  category: String, tags: [String], image: String,
  date: String, slug: String, status: String,
  pinned: Boolean, views: Number, comments: Array
});
const GallerySchema = new mongoose.Schema({
  id: Number, src: String, caption: String, date: String
});

const Post    = mongoose.model('Post',    PostSchema);
const Gallery = mongoose.model('Gallery', GallerySchema);

async function importData() {
  try {
    // Import posts
    if (db.posts && db.posts.length > 0) {
      await Post.deleteMany({});
      await Post.insertMany(db.posts);
      console.log('✅ Imported', db.posts.length, 'posts!');
    }

    // Import gallery
    if (db.gallery && db.gallery.length > 0) {
      await Gallery.deleteMany({});
      await Gallery.insertMany(db.gallery);
      console.log('✅ Imported', db.gallery.length, 'gallery photos!');
    }

    console.log('🎉 Import complete!');
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

importData();