# Panduan Deploy NexaDesk Online Hanya Dengan GitHub & Firebase

Dokumen ini berisi panduan langkah demi langkah untuk menjalankan aplikasi **NexaDesk** secara online menggunakan **GitHub** (repository & CI/CD) dan **Firebase** (Firestore Database, Hosting, & Cloud Functions).

---

## 🏗️ Arsitektur Sederhana

| Komponen | Layanan | Fungsi |
| :--- | :--- | :--- |
| **Frontend Web UI** | Firebase Hosting | Menyajikan tampilan web dashboard NexaDesk dari folder `dist/`. |
| **Backend API & Bot WhatsApp** | Firebase Cloud Functions v2 | Menjalankan Express API server, Socket.IO, dan bot Baileys WhatsApp. |
| **Database & Sesi WA** | Firebase Firestore | Menyimpan data chat, pesan, tiket, akun, serta kunci autentikasi WhatsApp (`auth state`). |
| **Otomatisasi Deploy** | GitHub Actions | Otomatis membangun & men-deploy kode ke Firebase setiap kali ada perubahan (`git push`). |

---

## 🚀 Langkah 1: Menyiapkan Project Firebase

1. Buka [Firebase Console](https://console.firebase.google.com/) dan buat project baru (contoh nama: `nexadesk-online`).
2. **Aktifkan Firestore Database**:
   - Buka menu **Build** > **Firestore Database**.
   - Klik **Create Database**, pilih lokasi server terdekat (misal `asia-southeast1` Singapura), dan pilih aturan keamanan awal **Production Mode** atau **Test Mode**.
3. **Dapatkan Credentials (Service Account Key)**:
   - Buka **Project Settings** (ikon roda gigi di kiri atas) > tab **Service accounts**.
   - Klik tombol **Generate new private key**.
   - Simpan file `.json` yang terunduh ke komputer Anda (file ini berisi kunci akses Firestore).

---

## Octocat Langkah 2: Menyiapkan Repository di GitHub

1. Buat repository baru di [GitHub](https://github.com/new) (misal nama repository: `nexadesk-web`).
2. Unggah/Push seluruh source code folder `nexadesk-web` ini ke GitHub:
   ```bash
   git init
   git add .
   git commit -m "Initial NexaDesk with Firebase & GitHub support"
   git branch -M main
   git remote add origin https://github.com/USERNAME/nexadesk-web.git
   git push -u origin main
   ```
3. **Tambahkan Secret di GitHub Repository**:
   - Buka repository Anda di GitHub > **Settings** > **Secrets and variables** > **Actions**.
   - Klik **New repository secret**.
   - Name: `FIREBASE_SERVICE_ACCOUNT`
   - Secret: Buka file `.json` Service Account yang didownload di Langkah 1, salin seluruh isinya (teks JSON), lalu paste di sini.
   - Klik **Add secret**.

---

## ⚡ Langkah 3: Deploying ke Firebase

### Opsi A: Deploy Otomatis Lewat GitHub Actions (Direkomendasikan)
Begitu file `.github/workflows/deploy.yml` dan `FIREBASE_SERVICE_ACCOUNT` secret sudah terpasang di GitHub:
- Setiap kali Anda melakukan `git push origin main`, GitHub Actions akan **otomatis memproses build dan deploy** ke Firebase.
- Anda dapat memantau statusnya pada tab **Actions** di repository GitHub Anda.

### Opsi B: Deploy Manual Lewat Terminal / Command Prompt
Jika Anda ingin men-deploy langsung dari laptop Anda:
1. Install Firebase CLI jika belum ada:
   ```bash
   npm install -g firebase-tools
   ```
2. Login ke akun Firebase Anda:
   ```bash
   firebase login
   ```
3. Atur ID project Firebase Anda di `.firebaserc`:
   ```bash
   firebase use --add nexadesk-online
   ```
4. Jalankan perintah deploy:
   ```bash
   npx firebase-tools deploy
   ```

---

## 🔐 Langkah 4: Mengisi API Key Gemini AI

Setelah NexaDesk online di Firebase:
1. Buka URL domain Firebase Hosting Anda (misal `https://nexadesk-online.web.app`).
2. Masuk ke dashboard NexaDesk.
3. Buka menu **Pengaturan**, masukkan **API Key Google Gemini** Anda (diambil dari [Google AI Studio](https://aistudio.google.com/app/apikey)), lalu simpan.

---

## 💡 Keunggulan Integrasi Firestore Ini
- **Koneksi WhatsApp Persisten**: Kunci autentikasi Baileys WhatsApp (`creds` & `session keys`) disimpan di Cloud Firestore, sehingga sesi WhatsApp Anda tidak terputus atau terhapus ketika instance cloud di-restart.
- **Dua Mode Otomatis**: Jika dijalankan di laptop tanpa Firebase, NexaDesk tetap berjalan normal menggunakan file lokal `db.json` & `data/sessions/`. Jika env Firebase terdeteksi, NexaDesk otomatis beralih menggunakan Cloud Firestore!
