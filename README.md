# Baileys API Service

Layanan Node.js berbasis Baileys untuk mengelola sesi WhatsApp dan mengirimkan pesan (Text, Image, Document) melalui REST API. Project ini dijalankan sebagai background service menggunakan PM2.

---

## 1. Prerequisites

Sebelum menjalankan aplikasi, pastikan Anda telah menyiapkan dan menginstal dependency berikut:
* **Node.js**: Versi 18 atau lebih tinggi.
* **npm**: Node Package Manager (biasanya terinstal bersama Node.js).
* **PM2**: Process Manager untuk Node.js (terinstal secara global di sistem).
* **MySQL / MariaDB**: Database server aktif untuk menyimpan sesi WhatsApp.
* **WhatsApp Active Session**: Smartphone/Akun WhatsApp siap scan QR untuk menghubungkan sesi.

---

## 2. Cara Install

Ikuti langkah-langkah di bawah ini untuk melakukan instalasi:

1. Buka terminal atau command prompt, lalu masuk ke folder project Node.js (`s/`):
   ```bash
   cd s
   ```

2. Instal seluruh dependency package node modules:
   ```bash
   npm install
   ```

3. Konfigurasikan koneksi database MySQL pada file `ecosystem.config.js` di dalam blok `env`:
   ```javascript
   env: {
     PORT: 3000,
     NODE_ENV: "production",
     DB_HOST: "127.0.0.1",       // Host database Anda
     DB_PORT: 3306,              // Port database Anda
     DB_USER: "root",            // User database Anda
     DB_PASSWORD: "YOUR_DB_PASSWORD", // Password database Anda
     DB_NAME: "baileys_manager"  // Nama database Anda
   }
   ```
   *Catatan: Pastikan database dengan nama tersebut sudah dibuat di MySQL Anda. Struktur tabel `wa_sessions` akan dibuat secara otomatis saat aplikasi pertama kali dijalankan.*

---

## 3. Cara Menyalakan & Mengelola Aplikasi

Untuk menjalankan aplikasi di background menggunakan **PM2**, jalankan perintah berikut di dalam folder `s/`:

### Menyalakan Aplikasi (Start)
```bash
pm2 start ecosystem.config.js
```

### Memeriksa Status Aplikasi
Untuk melihat apakah aplikasi berjalan dengan lancar:
```bash
pm2 status
```
atau secara spesifik:
```bash
pm2 show baileys-api
```

### Melihat Log Realtime
Untuk melihat log error atau aktivitas dari socket WhatsApp secara live:
```bash
pm2 logs baileys-api
```

### Menghentikan Aplikasi (Stop)
```bash
pm2 stop baileys-api
```

### Merestart Aplikasi
```bash
pm2 restart baileys-api
```

### Menghapus Aplikasi dari Daftar PM2 (Delete)
```bash
pm2 delete baileys-api
```
