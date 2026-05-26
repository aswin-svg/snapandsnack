# 📷 Snap & Snack — Setup Guide

Your personal travel, food & lifestyle blog. Built from scratch with Node.js.

## Pages included
- **Home** — Hero, featured post, recent posts
- **Blog** — All posts with search & category filter
- **Single post** — Full article with image, tags, share buttons, related posts
- **Gallery** — Masonry photo grid with lightbox
- **Admin panel** — Create, edit, delete posts + manage gallery photos

## How to run

### Step 1 — Install Node.js
Download from https://nodejs.org (choose LTS version) and install it.

### Step 2 — Open a terminal in this folder
- Windows: right-click the folder → "Open in Terminal"
- Mac: drag the folder onto the Terminal app

### Step 3 — Install dependencies (only once)
```
npm install
```

### Step 4 — Start your blog
```
npm start
```

### Step 5 — Open in browser
| Page | URL |
|------|-----|
| Your blog | http://localhost:3000 |
| All posts | http://localhost:3000/blog |
| Gallery | http://localhost:3000/gallery |
| Admin panel | http://localhost:3000/admin |

**Admin login:** username = `admin`, password = `admin123`

## How to write a post
1. Go to http://localhost:3000/admin
2. Log in
3. Click **"+ New post"**
4. Fill in the title, content, category, tags, and upload a photo
5. Click **"Publish post"** — done! 🚀

## How to add gallery photos
1. Go to http://localhost:3000/admin
2. Click **"📷 Manage gallery"**
3. Click the upload area, select your photos (multiple at once!)
4. Add a caption if you want
5. Click **"Upload photos"**

## Folder structure
```
snap-and-snack/
├── app.js                  ← The server (all logic)
├── blog.json               ← Your database (auto-created)
├── views/
│   ├── home.ejs            ← Home page
│   ├── blog.ejs            ← Blog listing
│   ├── post.ejs            ← Single post
│   ├── gallery.ejs         ← Photo gallery
│   ├── 404.ejs             ← Not found page
│   └── admin/
│       ├── login.ejs       ← Login page
│       ├── dashboard.ejs   ← Admin dashboard
│       ├── form.ejs        ← Create/edit post
│       └── gallery.ejs     ← Manage photos
├── public/
│   ├── css/style.css       ← All styles
│   ├── uploads/            ← Post images
│   └── gallery-uploads/    ← Gallery photos
└── package.json
```

## Changing your password
Open `app.js` and find this line:
```js
db.data ||= { ..., admin: { username: 'admin', password: bcrypt.hashSync('admin123', 10) } };
```
Change `'admin'` and `'admin123'` to your preferred credentials.
Then delete `blog.json` and restart with `npm start`.
