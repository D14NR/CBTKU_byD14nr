'use strict';

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Load environment variables
dotenv.config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Enhanced Security Headers
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

// Environment Variables
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const PORT = process.env.PORT || 3000;

// Validate environment variables
if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ Error: SUPABASE_URL dan SUPABASE_KEY harus diatur di environment variables');
    process.exit(1);
}

console.log('✅ Environment variables loaded successfully');

// Rate limiting configuration
const rateLimit = {};
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX_REQUESTS = 100;

// Helper function for rate limiting
function checkRateLimit(ip) {
    const now = Date.now();
    if (!rateLimit[ip]) {
        rateLimit[ip] = { count: 1, firstRequest: now };
        return true;
    }
    
    if (now - rateLimit[ip].firstRequest > RATE_LIMIT_WINDOW) {
        rateLimit[ip] = { count: 1, firstRequest: now };
        return true;
    }
    
    if (rateLimit[ip].count >= RATE_LIMIT_MAX_REQUESTS) {
        return false;
    }
    
    rateLimit[ip].count++;
    return true;
}

// Enhanced Supabase request helper with retry logic
async function supabaseRequest(path, method = 'GET', query = null, body = null, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            if (!SUPABASE_URL || !SUPABASE_KEY) {
                throw new Error('Database configuration missing');
            }

            const url = new URL(`${SUPABASE_URL}/rest/v1/${path}`);
            
            // Add query parameters
            if (query) {
                Object.entries(query).forEach(([key, value]) => {
                    if (value !== undefined && value !== null) {
                        url.searchParams.set(key, String(value));
                    }
                });
            }

            const options = {
                method: method.toUpperCase(),
                headers: {
                    'apikey': SUPABASE_KEY,
                    'Authorization': `Bearer ${SUPABASE_KEY}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=representation,resolution=merge-duplicates'
                },
                timeout: 10000 // 10 second timeout
            };

            // Add body for POST, PUT, PATCH requests
            if (body && ['POST', 'PUT', 'PATCH'].includes(options.method)) {
                options.body = JSON.stringify(body);
            }

            const response = await fetch(url, options);
            
            // Handle rate limiting from Supabase
            if (response.status === 429) {
                const retryAfter = response.headers.get('Retry-After') || 1;
                await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
                continue;
            }

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`Database error (${response.status}):`, errorText);
                
                // Don't retry on client errors (4xx)
                if (response.status >= 400 && response.status < 500) {
                    throw new Error(`Database error: ${response.status} - ${errorText}`);
                }
                
                // Retry on server errors (5xx)
                if (attempt < retries) {
                    await new Promise(resolve => setTimeout(resolve, attempt * 1000));
                    continue;
                }
                
                throw new Error(`Database error after ${retries} attempts: ${response.status}`);
            }

            // Handle 204 No Content
            if (response.status === 204) {
                return null;
            }

            const data = await response.json();
            return data;

        } catch (error) {
            console.error(`Attempt ${attempt} failed:`, error.message);
            if (attempt === retries) {
                throw error;
            }
            await new Promise(resolve => setTimeout(resolve, attempt * 1000));
        }
    }
}

// JWT token generation and verification
function generateToken(user) {
    const payload = {
        userId: user.id,
        username: user.nis_username,
        role: 'student',
        exp: Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60) // 7 days
    };
    
    return jwt.sign(payload, JWT_SECRET);
}

function verifyToken(token) {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (error) {
        return null;
    }
}

// Authentication middleware
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ success: false, message: 'Token tidak ditemukan' });
    }
    
    const user = verifyToken(token);
    if (!user) {
        return res.status(403).json({ success: false, message: 'Token tidak valid' });
    }
    
    req.user = user;
    next();
}

// Password hashing
async function hashPassword(password) {
    const salt = await bcrypt.genSalt(10);
    return await bcrypt.hash(password, salt);
}

async function comparePassword(password, hash) {
    return await bcrypt.compare(password, hash);
}

// Data sanitization and validation
function sanitizeInput(input) {
    if (typeof input === 'string') {
        return input.trim().replace(/[<>]/g, '');
    }
    return input;
}

function validateEmail(email) {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email);
}

function validatePhone(phone) {
    const re = /^[0-9]{10,15}$/;
    return re.test(phone.replace(/\D/g, ''));
}

// Safe user data (remove sensitive information)
function safeUser(user) {
    if (!user) return null;
    
    const safeUser = { ...user };
    delete safeUser.password;
    delete safeUser.token;
    delete safeUser.created_at;
    delete safeUser.updated_at;
    
    return safeUser;
}

// Required fields validation
function validateRequiredFields(data, fields) {
    const errors = [];
    
    fields.forEach(field => {
        if (!data[field] || String(data[field]).trim() === '') {
            errors.push(`Field "${field}" wajib diisi`);
        }
    });
    
    return errors;
}

// Cache system for frequently accessed data
const cache = {
    agenda: {
        data: null,
        timestamp: 0,
        ttl: 5 * 60 * 1000 // 5 minutes
    }
};

async function getCachedAgenda() {
    const now = Date.now();
    if (cache.agenda.data && (now - cache.agenda.timestamp) < cache.agenda.ttl) {
        return cache.agenda.data;
    }
    
    try {
        const data = await supabaseRequest('agenda_ujian', 'GET', {
            select: 'id,agenda_ujian,tgljam_mulai,tgljam_selesai,status',
            tgljam_selesai: `gte.${new Date().toISOString()}`,
            order: 'tgljam_mulai.asc'
        });
        
        cache.agenda.data = data;
        cache.agenda.timestamp = now;
        
        return data;
    } catch (error) {
        console.error('Cache update error:', error);
        return cache.agenda.data || [];
    }
}

// Create Express Router
const router = express.Router();

// Health check endpoint
router.get('/health', (req, res) => {
    res.json({
        success: true,
        message: 'Server is running',
        timestamp: new Date().toISOString(),
        version: '1.0.0'
    });
});

// Get server statistics
router.get('/stats', authenticateToken, async (req, res) => {
    try {
        const [agendaCount, userCount, examCount] = await Promise.all([
            supabaseRequest('agenda_ujian', 'GET', { select: 'count', status: 'eq.Aktif' }),
            supabaseRequest('peserta', 'GET', { select: 'count', status: 'eq.Aktif' }),
            supabaseRequest('jawaban', 'GET', { select: 'count', status: 'eq.Selesai' })
        ]);
        
        res.json({
            success: true,
            data: {
                agenda_aktif: agendaCount?.[0]?.count || 0,
                peserta_aktif: userCount?.[0]?.count || 0,
                ujian_selesai: examCount?.[0]?.count || 0
            }
        });
    } catch (error) {
        console.error('Stats error:', error);
        res.status(500).json({ success: false, message: 'Error mengambil statistik' });
    }
});

// Get agenda with caching
router.get('/agenda', async (req, res) => {
    try {
        // Check rate limiting
        if (!checkRateLimit(req.ip)) {
            return res.status(429).json({ 
                success: false, 
                message: 'Terlalu banyak permintaan. Silakan coba lagi nanti.' 
            });
        }
        
        const data = await getCachedAgenda();
        
        res.json({ 
            success: true, 
            data: data || [],
            cached: cache.agenda.timestamp > 0
        });
    } catch (error) {
        console.error('Agenda error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Register with enhanced validation
router.post('/register', async (req, res) => {
    try {
        // Check rate limiting
        if (!checkRateLimit(req.ip)) {
            return res.status(429).json({ 
                success: false, 
                message: 'Terlalu banyak permintaan. Silakan coba lagi nanti.' 
            });
        }
        
        const form = req.body || {};
        
        // Sanitize inputs
        Object.keys(form).forEach(key => {
            if (typeof form[key] === 'string') {
                form[key] = sanitizeInput(form[key]);
            }
        });
        
        // Validate required fields
        const requiredFields = [
            'agenda_id', 'nama', 'jenjang', 'kelas', 
            'sekolah', 'no_wa', 'wa_ortu', 'password', 'username'
        ];
        
        const validationErrors = validateRequiredFields(form, requiredFields);
        if (validationErrors.length > 0) {
            return res.status(400).json({ 
                success: false, 
                message: validationErrors.join(', ') 
            });
        }
        
        // Validate phone numbers
        if (!validatePhone(form.no_wa)) {
            return res.status(400).json({ 
                success: false, 
                message: 'Nomor WhatsApp tidak valid' 
            });
        }
        
        if (!validatePhone(form.wa_ortu)) {
            return res.status(400).json({ 
                success: false, 
                message: 'Nomor WhatsApp orang tua tidak valid' 
            });
        }
        
        // Validate username format
        const usernameRegex = /^[a-zA-Z0-9_]{3,20}$/;
        if (!usernameRegex.test(form.username)) {
            return res.status(400).json({ 
                success: false, 
                message: 'Username harus 3-20 karakter, hanya boleh huruf, angka, dan underscore' 
            });
        }
        
        // Check if user already exists
        const existingUser = await supabaseRequest('peserta', 'GET', {
            select: 'id',
            or: `(nis_username.eq.${form.username},no_wa_peserta.eq.${form.no_wa})`,
            limit: 1
        });
        
        if (existingUser && existingUser.length > 0) {
            return res.status(400).json({ 
                success: false, 
                message: 'Username atau nomor WhatsApp sudah terdaftar' 
            });
        }
        
        // Hash password
        const hashedPassword = await hashPassword(form.password);
        
        // Prepare user data
        const userData = {
            nama_peserta: form.nama.toUpperCase(),
            nis_username: form.username,
            password: hashedPassword,
            jenjang_studi: form.jenjang,
            kelas: form.kelas,
            asal_sekolah: form.sekolah,
            no_wa_peserta: form.no_wa,
            no_wa_ortu: form.wa_ortu,
            id_agenda: form.agenda_id,
            status: 'Aktif',
            created_at: new Date().toISOString()
        };
        
        // Insert user
        const result = await supabaseRequest('peserta', 'POST', null, userData);
        
        // Get agenda name
        let agendaName = '-';
        try {
            const agenda = await supabaseRequest('agenda_ujian', 'GET', {
                select: 'agenda_ujian',
                id: `eq.${form.agenda_id}`,
                limit: 1
            });
            agendaName = agenda?.[0]?.agenda_ujian || '-';
        } catch (error) {
            console.error('Error fetching agenda name:', error);
        }
        
        // Generate JWT token
        const token = generateToken(result[0]);
        
        res.json({ 
            success: true, 
            data: safeUser(result[0]),
            token: token,
            nama_agenda: agendaName,
            message: 'Registrasi berhasil'
        });
        
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Terjadi kesalahan saat registrasi' 
        });
    }
});

// Login with enhanced security
router.post('/login', async (req, res) => {
    try {
        // Check rate limiting
        if (!checkRateLimit(req.ip)) {
            return res.status(429).json({ 
                success: false, 
                message: 'Terlalu banyak permintaan. Silakan coba lagi nanti.' 
            });
        }
        
        const { username, password } = req.body;
        
        if (!username || !password) {
            return res.status(400).json({ 
                success: false, 
                message: 'Username dan password wajib diisi' 
            });
        }
        
        // Find user by username or phone
        const user = await supabaseRequest('peserta', 'GET', {
            select: 'id,nama_peserta,nis_username,jenjang_studi,kelas,asal_sekolah,no_wa_peserta,no_wa_ortu,id_agenda,status,password,login_attempts,last_login',
            or: `(nis_username.eq.${username},no_wa_peserta.eq.${username})`,
            limit: 1
        });
        
        if (!user || user.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'Akun tidak ditemukan' 
            });
        }
        
        const userData = user[0];
        
        // Check if account is locked
        if (userData.login_attempts >= 5) {
            const lastAttempt = new Date(userData.last_login);
            const now = new Date();
            const hoursSinceLastAttempt = (now - lastAttempt) / (1000 * 60 * 60);
            
            if (hoursSinceLastAttempt < 24) {
                return res.status(423).json({ 
                    success: false, 
                    message: 'Akun terkunci. Coba lagi setelah 24 jam.' 
                });
            }
        }
        
        // Check account status
        if (userData.status !== 'Aktif') {
            return res.status(403).json({ 
                success: false, 
                message: 'Akun tidak aktif' 
            });
        }
        
        // Verify password
        const passwordValid = await comparePassword(password, userData.password);
        
        if (!passwordValid) {
            // Update login attempts
            await supabaseRequest(
                'peserta',
                'PATCH',
                { id: `eq.${userData.id}` },
                { 
                    login_attempts: (userData.login_attempts || 0) + 1,
                    last_login: new Date().toISOString()
                }
            );
            
            return res.status(401).json({ 
                success: false, 
                message: 'Password salah' 
            });
        }
        
        // Reset login attempts on successful login
        await supabaseRequest(
            'peserta',
            'PATCH',
            { id: `eq.${userData.id}` },
            { 
                login_attempts: 0,
                last_login: new Date().toISOString()
            }
        );
        
        // Generate JWT token
        const token = generateToken(userData);
        
        res.json({
            success: true,
            data: safeUser(userData),
            token: token,
            message: 'Login berhasil'
        });
        
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Terjadi kesalahan saat login' 
        });
    }
});

// Token verification
router.post('/verify-token', async (req, res) => {
    try {
        const { agenda_id, token } = req.body;
        
        if (!agenda_id || !token) {
            return res.status(400).json({ 
                success: false, 
                message: 'Agenda ID dan token wajib diisi' 
            });
        }
        
        const agenda = await supabaseRequest('agenda_ujian', 'GET', {
            select: 'token_ujian,agenda_ujian,status',
            id: `eq.${agenda_id}`,
            limit: 1
        });
        
        if (!agenda || agenda.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'Agenda tidak ditemukan' 
            });
        }
        
        const agendaData = agenda[0];
        
        if (agendaData.status !== 'Aktif') {
            return res.status(400).json({ 
                success: false, 
                message: 'Agenda tidak aktif' 
            });
        }
        
        if (agendaData.token_ujian !== token.toUpperCase()) {
            return res.status(401).json({ 
                success: false, 
                message: 'Token salah' 
            });
        }
        
        res.json({ 
            success: true, 
            agenda_name: agendaData.agenda_ujian 
        });
        
    } catch (error) {
        console.error('Token verification error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error verifikasi token' 
        });
    }
});

// Get subjects with progress tracking
router.get('/mapel', authenticateToken, async (req, res) => {
    try {
        const { agenda_id, peserta_id } = req.query;
        
        if (!agenda_id || !peserta_id) {
            return res.status(400).json({ 
                success: false, 
                message: 'Agenda ID dan peserta ID wajib' 
            });
        }
        
        // Get subjects
        const subjects = await supabaseRequest('mata_pelajaran', 'GET', {
            select: 'id,nama_mata_pelajaran,jumlah_soal,durasi_ujian,status_mapel',
            id_agenda: `eq.${agenda_id}`,
            status_mapel: 'eq.Siap',
            order: 'id.asc'
        });
        
        if (!subjects || subjects.length === 0) {
            return res.json({ success: true, data: [] });
        }
        
        // Get exam progress
        const examProgress = await supabaseRequest('jawaban', 'GET', {
            select: 'id_mapel,status,nilai,tgljam_selesai',
            id_agenda: `eq.${agenda_id}`,
            id_peserta: `eq.${peserta_id}`
        });
        
        // Combine data
        const result = subjects.map(subject => {
            const progress = examProgress?.find(ep => ep.id_mapel === subject.id);
            
            return {
                ...subject,
                status_kerjakan: progress ? progress.status : 'Belum',
                nilai: progress ? progress.nilai : null,
                tgljam_selesai: progress ? progress.tgljam_selesai : null
            };
        });
        
        res.json({ success: true, data: result });
        
    } catch (error) {
        console.error('Subjects error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error mengambil data mata pelajaran' 
        });
    }
});

// Get exam questions with enhanced features
router.post('/get-soal', authenticateToken, async (req, res) => {
    try {
        const { agenda_id, peserta_id, mapel_id } = req.body;
        
        if (!agenda_id || !peserta_id || !mapel_id) {
            return res.status(400).json({ 
                success: false, 
                message: 'Data tidak lengkap' 
            });
        }
        
        // Get subject info
        const [subject, user, agenda] = await Promise.all([
            supabaseRequest('mata_pelajaran', 'GET', {
                select: 'id,nama_mata_pelajaran,durasi_ujian,jumlah_soal',
                id: `eq.${mapel_id}`,
                limit: 1
            }),
            supabaseRequest('peserta', 'GET', {
                select: 'nama_peserta',
                id: `eq.${peserta_id}`,
                limit: 1
            }),
            supabaseRequest('agenda_ujian', 'GET', {
                select: 'agenda_ujian',
                id: `eq.${agenda_id}`,
                limit: 1
            })
        ]);
        
        if (!subject || subject.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'Mata pelajaran tidak ditemukan' 
            });
        }
        
        const subjectData = subject[0];
        const userName = user?.[0]?.nama_peserta || '-';
        const agendaName = agenda?.[0]?.agenda_ujian || '-';
        
        // Get questions with randomization
        const questions = await supabaseRequest('bank_soal', 'GET', {
            select: 'id,pertanyaan,type_soal,pilihan_a,pilihan_b,pilihan_c,pilihan_d,pilihan_e,gambar_url,pernyataan_1,pernyataan_2,pernyataan_3,pernyataan_4,pernyataan_5,pernyataan_6,pernyataan_7,pernyataan_8,pernyataan_kiri_1,pernyataan_kiri_2,pernyataan_kiri_3,pernyataan_kiri_4,pernyataan_kiri_5,pernyataan_kiri_6,pernyataan_kiri_7,pernyataan_kiri_8,pernyataan_kanan_1,pernyataan_kanan_2,pernyataan_kanan_3,pernyataan_kanan_4,pernyataan_kanan_5,pernyataan_kanan_6,pernyataan_kanan_7,pernyataan_kanan_8,kunci_jawaban,point_soal,no_soal',
            id_mapel: `eq.${mapel_id}`,
            order: 'no_soal.asc',
            limit: 500
        });
        
        // Randomize questions if needed
        if (questions && questions.length > 1) {
            // Simple shuffling algorithm
            for (let i = questions.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [questions[i], questions[j]] = [questions[j], questions[i]];
            }
        }
        
        // Get existing exam session
        const existingExam = await supabaseRequest('jawaban', 'GET', {
            select: 'id,jawaban,tgljam_mulai,status,tgljam_login',
            id_peserta: `eq.${peserta_id}`,
            id_mapel: `eq.${mapel_id}`,
            limit: 1
        });
        
        let status = 'Baru';
        let answers = '';
        let startTime = new Date().toISOString();
        let examId = null;
        
        if (existingExam && existingExam.length > 0) {
            const examData = existingExam[0];
            status = examData.status === 'Selesai' ? 'Selesai' : 'Lanjut';
            answers = examData.jawaban || '';
            startTime = examData.tgljam_mulai;
            examId = examData.id;
        } else {
            // Initialize answer string
            answers = questions ? Array(questions.length).fill('-').join('|') : '';
            
            // Create new exam session
            const newExam = await supabaseRequest('jawaban', 'POST', null, {
                id_peserta: peserta_id,
                id_agenda: agenda_id,
                id_mapel: mapel_id,
                nama_peserta_snap: userName,
                nama_agenda_snap: agendaName,
                nama_mapel_snap: subjectData.nama_mata_pelajaran,
                jawaban: answers,
                tgljam_login: startTime,
                tgljam_mulai: startTime,
                status: 'Proses',
                created_at: startTime
            });
            
            examId = newExam?.[0]?.id;
        }
        
        // Remove answer keys from questions
        const safeQuestions = questions?.map(q => {
            const safeQ = { ...q };
            delete safeQ.kunci_jawaban;
            return safeQ;
        }) || [];
        
        res.json({
            success: true,
            status: status,
            exam_id: examId,
            waktu_mulai: startTime,
            jawaban_sebelumnya: answers,
            mapel_detail: subjectData,
            data_soal: safeQuestions,
            total_soal: safeQuestions.length,
            durasi_menit: subjectData.durasi_ujian
        });
        
    } catch (error) {
        console.error('Get questions error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error mengambil soal ujian' 
        });
    }
});

// Save answers with validation
router.post('/save-jawaban', authenticateToken, async (req, res) => {
    try {
        const { exam_id, jawaban, current_question, total_questions } = req.body;
        
        if (!exam_id || jawaban === undefined) {
            return res.status(400).json({ 
                success: false, 
                message: 'Data tidak lengkap' 
            });
        }
        
        // Validate answer format
        if (typeof jawaban !== 'string') {
            return res.status(400).json({ 
                success: false, 
                message: 'Format jawaban tidak valid' 
            });
        }
        
        // Update exam progress
        const updateData = {
            jawaban: jawaban,
            updated_at: new Date().toISOString()
        };
        
        // Add progress tracking
        if (current_question !== undefined && total_questions !== undefined) {
            updateData.progress = Math.round((current_question / total_questions) * 100);
        }
        
        await supabaseRequest(
            'jawaban',
            'PATCH',
            { id: `eq.${exam_id}` },
            updateData
        );
        
        res.json({ 
            success: true, 
            message: 'Jawaban disimpan',
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Save answer error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error menyimpan jawaban' 
        });
    }
});

// Finish exam with scoring
router.post('/selesai-ujian', authenticateToken, async (req, res) => {
    try {
        const { exam_id, jawaban } = req.body;
        
        if (!exam_id) {
            return res.status(400).json({ 
                success: false, 
                message: 'Exam ID wajib diisi' 
            });
        }
        
        // Get exam data
        const examData = await supabaseRequest('jawaban', 'GET', {
            select: 'id,id_mapel,id_peserta,jawaban,data_soal',
            id: `eq.${exam_id}`,
            limit: 1
        });
        
        if (!examData || examData.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'Data ujian tidak ditemukan' 
            });
        }
        
        const exam = examData[0];
        
        // Calculate score if answers provided
        let score = null;
        let correctAnswers = 0;
        let totalQuestions = 0;
        
        if (jawaban && exam.data_soal) {
            // Parse questions and answers
            const questions = JSON.parse(exam.data_soal);
            const userAnswers = jawaban.split('|');
            
            totalQuestions = Math.min(questions.length, userAnswers.length);
            
            for (let i = 0; i < totalQuestions; i++) {
                if (questions[i].kunci_jawaban === userAnswers[i]) {
                    correctAnswers++;
                }
            }
            
            score = Math.round((correctAnswers / totalQuestions) * 100);
        }
        
        // Update exam status
        const updateData = {
            jawaban: jawaban || exam.jawaban,
            status: 'Selesai',
            tgljam_selesai: new Date().toISOString(),
            nilai: score,
            updated_at: new Date().toISOString()
        };
        
        await supabaseRequest(
            'jawaban',
            'PATCH',
            { id: `eq.${exam_id}` },
            updateData
        );
        
        res.json({
            success: true,
            message: 'Ujian selesai',
            nilai: score,
            benar: correctAnswers,
            total: totalQuestions,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Finish exam error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error menyelesaikan ujian' 
        });
    }
});

// Get exam results
router.get('/hasil-ujian', authenticateToken, async (req, res) => {
    try {
        const { peserta_id } = req.query;
        
        if (!peserta_id) {
            return res.status(400).json({ 
                success: false, 
                message: 'Peserta ID wajib' 
            });
        }
        
        const results = await supabaseRequest('jawaban', 'GET', {
            select: 'id,id_mapel,id_agenda,nama_mapel_snap,nilai,tgljam_selesai,status',
            id_peserta: `eq.${peserta_id}`,
            status: 'eq.Selesai',
            order: 'tgljam_selesai.desc'
        });
        
        res.json({ 
            success: true, 
            data: results || [] 
        });
        
    } catch (error) {
        console.error('Results error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error mengambil hasil ujian' 
        });
    }
});

// Get user profile
router.get('/profile', authenticateToken, async (req, res) => {
    try {
        const { user_id } = req.query;
        
        if (!user_id) {
            return res.status(400).json({ 
                success: false, 
                message: 'User ID wajib' 
            });
        }
        
        const user = await supabaseRequest('peserta', 'GET', {
            select: 'id,nama_peserta,nis_username,jenjang_studi,kelas,asal_sekolah,no_wa_peserta,no_wa_ortu,id_agenda,status,created_at',
            id: `eq.${user_id}`,
            limit: 1
        });
        
        if (!user || user.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'User tidak ditemukan' 
            });
        }
        
        res.json({ 
            success: true, 
            data: safeUser(user[0]) 
        });
        
    } catch (error) {
        console.error('Profile error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error mengambil profile' 
        });
    }
});

// Update user profile
router.post('/update-profile', authenticateToken, async (req, res) => {
    try {
        const { user_id, nama, no_wa, wa_ortu } = req.body;
        
        if (!user_id) {
            return res.status(400).json({ 
                success: false, 
                message: 'User ID wajib' 
            });
        }
        
        const updateData = {};
        
        if (nama) updateData.nama_peserta = nama.toUpperCase();
        if (no_wa) {
            if (!validatePhone(no_wa)) {
                return res.status(400).json({ 
                    success: false, 
                    message: 'Nomor WhatsApp tidak valid' 
                });
            }
            updateData.no_wa_peserta = no_wa;
        }
        if (wa_ortu) {
            if (!validatePhone(wa_ortu)) {
                return res.status(400).json({ 
                    success: false, 
                    message: 'Nomor WhatsApp orang tua tidak valid' 
                });
            }
            updateData.no_wa_ortu = wa_ortu;
        }
        
        if (Object.keys(updateData).length === 0) {
            return res.status(400).json({ 
                success: false, 
                message: 'Tidak ada data untuk diupdate' 
            });
        }
        
        updateData.updated_at = new Date().toISOString();
        
        await supabaseRequest(
            'peserta',
            'PATCH',
            { id: `eq.${user_id}` },
            updateData
        );
        
        res.json({ 
            success: true, 
            message: 'Profile berhasil diupdate' 
        });
        
    } catch (error) {
        console.error('Update profile error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error mengupdate profile' 
        });
    }
});

// Change password
router.post('/change-password', authenticateToken, async (req, res) => {
    try {
        const { user_id, old_password, new_password } = req.body;
        
        if (!user_id || !old_password || !new_password) {
            return res.status(400).json({ 
                success: false, 
                message: 'Data tidak lengkap' 
            });
        }
        
        if (new_password.length < 6) {
            return res.status(400).json({ 
                success: false, 
                message: 'Password baru minimal 6 karakter' 
            });
        }
        
        // Get current password
        const user = await supabaseRequest('peserta', 'GET', {
            select: 'password',
            id: `eq.${user_id}`,
            limit: 1
        });
        
        if (!user || user.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'User tidak ditemukan' 
            });
        }
        
        // Verify old password
        const passwordValid = await comparePassword(old_password, user[0].password);
        
        if (!passwordValid) {
            return res.status(401).json({ 
                success: false, 
                message: 'Password lama salah' 
            });
        }
        
        // Hash new password
        const hashedPassword = await hashPassword(new_password);
        
        // Update password
        await supabaseRequest(
            'peserta',
            'PATCH',
            { id: `eq.${user_id}` },
            { 
                password: hashedPassword,
                updated_at: new Date().toISOString()
            }
        );
        
        res.json({ 
            success: true, 
            message: 'Password berhasil diubah' 
        });
        
    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error mengubah password' 
        });
    }
});

// Logout (server-side token invalidation if needed)
router.post('/logout', authenticateToken, async (req, res) => {
    try {
        // In a production environment, you might want to implement token blacklisting here
        
        res.json({ 
            success: true, 
            message: 'Logout berhasil' 
        });
        
    } catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error logout' 
        });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    
    res.status(500).json({
        success: false,
        message: 'Terjadi kesalahan internal server',
        error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: 'Endpoint tidak ditemukan'
    });
});

// Register routes
app.use('/api', router);

// Start server
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`✅ Server berjalan di port ${PORT}`);
        console.log(`📚 API Documentation: http://localhost:${PORT}/api/health`);
        console.log(`🚀 Mode: ${process.env.NODE_ENV || 'development'}`);
    });
}

module.exports = app;
