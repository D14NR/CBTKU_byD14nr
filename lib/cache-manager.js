/**
 * OFFLINE VALIDATOR untuk CBTKU
 * Validasi login, token, dan akses tanpa koneksi internet
 */
class OfflineValidator {
  constructor(cacheManager) {
    this.cache = cacheManager;
    this.currentAgenda = null;
    this.participants = new Map();
    this.validTokens = new Set();
    this.agendaTimeValid = false;
  }

  /**
   * Initialize dengan data dari cache
   */
  async init(agendaId) {
    try {
      // Load package dari cache
      const packageData = await this.cache.getExamPackage(agendaId);
      
      if (!packageData) {
        throw new Error('Package belum didownload. Silakan download terlebih dahulu.');
      }

      this.currentAgenda = packageData.agenda;
      
      // Setup participants map untuk validasi cepat
      this.participants.clear();
      (packageData.peserta_list || []).forEach(peserta => {
        this.participants.set(peserta.username, {
          id: peserta.id,
          password_hash: peserta.password_hash,
          nama: peserta.nama,
          kelas: peserta.kelas,
          sekolah: peserta.sekolah
        });
      });

      // Setup valid tokens
      this.validTokens.clear();
      if (this.currentAgenda.token_ujian) {
        this.validTokens.add(this.currentAgenda.token_ujian.trim().toUpperCase());
      }

      // Validasi waktu agenda
      this.validateAgendaTime();

      console.log(`OfflineValidator initialized for agenda ${agendaId}`);
      console.log(`- Participants: ${this.participants.size}`);
      console.log(`- Token: ${this.currentAgenda.token_ujian ? 'Available' : 'Missing'}`);
      console.log(`- Agenda time valid: ${this.agendaTimeValid}`);

      return true;

    } catch (error) {
      console.error('OfflineValidator init error:', error);
      throw error;
    }
  }

  /**
   * Validasi login user offline
   */
  validateLogin(username, password) {
    // Validasi input
    if (!username || !password) {
      return {
        valid: false,
        message: 'Username dan password harus diisi'
      };
    }

    // Cek apakah user terdaftar
    if (!this.participants.has(username)) {
      return {
        valid: false,
        message: 'Username tidak terdaftar'
      };
    }

    const user = this.participants.get(username);
    
    // Generate hash dari input
    const inputHash = this.hashCredentials(username, password);
    
    // Bandingkan dengan hash yang tersimpan
    if (user.password_hash === inputHash) {
      return {
        valid: true,
        user: {
          id: user.id,
          nama: user.nama,
          username: username,
          kelas: user.kelas,
          sekolah: user.sekolah,
          agenda_id: this.currentAgenda?.id
        },
        agenda: this.currentAgenda,
        message: 'Login berhasil (offline mode)'
      };
    }

    return {
      valid: false,
      message: 'Password salah'
    };
  }

  /**
   * Validasi token ujian
   */
  validateToken(token) {
    if (!token || typeof token !== 'string') {
      return {
        valid: false,
        message: 'Token harus diisi'
      };
    }

    const normalizedToken = token.trim().toUpperCase();
    const isValid = this.validTokens.has(normalizedToken);

    return {
      valid: isValid,
      message: isValid ? 'Token valid' : 'Token tidak valid',
      token_masked: normalizedToken.substring(0, 3) + '***' + normalizedToken.substring(normalizedToken.length - 3)
    };
  }

  /**
   * Validasi waktu agenda
   */
  validateAgendaTime() {
    if (!this.currentAgenda) {
      this.agendaTimeValid = false;
      return {
        valid: false,
        message: 'Agenda tidak ditemukan'
      };
    }

    const now = new Date();
    const startTime = new Date(this.currentAgenda.tgljam_mulai);
    const endTime = new Date(this.currentAgenda.tgljam_selesai);

    if (now < startTime) {
      const timeUntilStart = startTime - now;
      const hours = Math.floor(timeUntilStart / (1000 * 60 * 60));
      const minutes = Math.floor((timeUntilStart % (1000 * 60 * 60)) / (1000 * 60));

      this.agendaTimeValid = false;
      
      return {
        valid: false,
        status: 'not_started',
        message: `Agenda belum dimulai`,
        details: `Mulai dalam ${hours} jam ${minutes} menit`,
        start_time: startTime.toISOString(),
        end_time: endTime.toISOString(),
        now: now.toISOString()
      };
    }

    if (now > endTime) {
      const timeSinceEnd = now - endTime;
      const hours = Math.floor(timeSinceEnd / (1000 * 60 * 60));
      const minutes = Math.floor((timeSinceEnd % (1000 * 60 * 60)) / (1000 * 60));

      this.agendaTimeValid = false;
      
      return {
        valid: false,
        status: 'ended',
        message: `Agenda sudah berakhir`,
        details: `Berakhir ${hours} jam ${minutes} menit yang lalu`,
        start_time: startTime.toISOString(),
        end_time: endTime.toISOString(),
        now: now.toISOString()
      };
    }

    const timeLeft = endTime - now;
    const hoursLeft = Math.floor(timeLeft / (1000 * 60 * 60));
    const minutesLeft = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));

    this.agendaTimeValid = true;
    
    return {
      valid: true,
      status: 'active',
      message: `Agenda sedang berlangsung`,
      details: `Sisa waktu: ${hoursLeft} jam ${minutesLeft} menit`,
      start_time: startTime.toISOString(),
      end_time: endTime.toISOString(),
      now: now.toISOString(),
      time_left_ms: timeLeft,
      time_left: {
        hours: hoursLeft,
        minutes: minutesLeft,
        total_minutes: Math.floor(timeLeft / (1000 * 60))
      }
    };
  }

  /**
   * Validasi akses user ke mapel tertentu
   */
  async validateMapelAccess(mapelId) {
    try {
      // Cek apakah mapel ada di package
      const packageData = await this.cache.getExamPackage(this.currentAgenda?.id);
      
      if (!packageData) {
        return {
          valid: false,
          message: 'Package tidak ditemukan'
        };
      }

      // Cek apakah mapel ada dalam daftar
      const mapelExists = packageData.mapel_list?.some(m => m.id == mapelId);
      
      if (!mapelExists) {
        return {
          valid: false,
          message: 'Mata pelajaran tidak ditemukan'
        };
      }

      // Cek apakah mapel ready
      const mapel = packageData.mapel_list.find(m => m.id == mapelId);
      
      if (!mapel) {
        return {
          valid: false,
          message: 'Detail mata pelajaran tidak ditemukan'
        };
      }

      // Cek apakah ada soal untuk mapel ini
      const questions = await this.cache.getQuestionsByMapel(this.currentAgenda.id, mapelId);
      
      if (!questions || questions.length === 0) {
        return {
          valid: false,
          message: 'Tidak ada soal untuk mata pelajaran ini'
        };
      }

      return {
        valid: true,
        mapel: mapel,
        questions_count: questions.length,
        message: 'Akses mapel valid'
      };

    } catch (error) {
      console.error('Mapel access validation error:', error);
      return {
        valid: false,
        message: 'Error validasi akses mapel'
      };
    }
  }

  /**
   * Validasi lengkap sebelum mulai ujian
   */
  async validateExamStart(mapelId, token = null) {
    const results = {
      login: null,
      token: null,
      agenda_time: null,
      mapel_access: null,
      overall_valid: false,
      errors: []
    };

    // 1. Validasi waktu agenda
    results.agenda_time = this.validateAgendaTime();
    if (!results.agenda_time.valid) {
      results.errors.push(`Waktu agenda: ${results.agenda_time.message}`);
    }

    // 2. Validasi token (jika diberikan)
    if (token) {
      results.token = this.validateToken(token);
      if (!results.token.valid) {
        results.errors.push(`Token: ${results.token.message}`);
      }
    }

    // 3. Validasi akses mapel
    if (mapelId) {
      results.mapel_access = await this.validateMapelAccess(mapelId);
      if (!results.mapel_access.valid) {
        results.errors.push(`Mapel: ${results.mapel_access.message}`);
      }
    }

    // 4. Tentukan overall validity
    results.overall_valid = 
      results.agenda_time.valid && 
      (!token || results.token?.valid) && 
      (!mapelId || results.mapel_access?.valid);

    return results;
  }

  /**
   * Generate hash untuk credentials
   */
  hashCredentials(username, password) {
    // Simple hash function (sama dengan yang di backend)
    const str = username + ':' + password;
    let hash = 0;
    
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    
    return Math.abs(hash).toString(16).substring(0, 8);
  }

  /**
   * Get agenda info
   */
  getAgendaInfo() {
    return {
      ...this.currentAgenda,
      participants_count: this.participants.size,
      time_valid: this.agendaTimeValid
    };
  }

  /**
   * Get user info by username
   */
  getUserInfo(username) {
    if (!this.participants.has(username)) {
      return null;
    }
    
    const user = this.participants.get(username);
    return {
      ...user,
      username: username
    };
  }

  /**
   * Check if user exists
   */
  userExists(username) {
    return this.participants.has(username);
  }

  /**
   * Get all mapel info
   */
  async getAllMapelInfo() {
    try {
      const packageData = await this.cache.getExamPackage(this.currentAgenda?.id);
      
      if (!packageData || !packageData.mapel_list) {
        return [];
      }

      // Tambah info jumlah soal untuk setiap mapel
      const mapelInfo = await Promise.all(
        packageData.mapel_list.map(async (mapel) => {
          const questions = await this.cache.getQuestionsByMapel(this.currentAgenda.id, mapel.id);
          return {
            ...mapel,
            questions_count: questions?.length || 0,
            has_questions: (questions?.length || 0) > 0
          };
        })
      );

      return mapelInfo;

    } catch (error) {
      console.error('Get mapel info error:', error);
      return [];
    }
  }

  /**
   * Get package metadata
   */
  async getPackageMetadata() {
    const packageData = await this.cache.getExamPackage(this.currentAgenda?.id);
    
    if (!packageData) {
      return null;
    }

    return {
      agenda_name: packageData.agenda?.agenda_ujian || 'Unknown',
      package_version: packageData.metadata?.package_version || '1.0',
      generated_at: packageData.metadata?.generated_at || new Date().toISOString(),
      valid_until: packageData.agenda?.tgljam_selesai || new Date().toISOString(),
      total_mapel: packageData.mapel_list?.length || 0,
      total_participants: packageData.peserta_list?.length || 0,
      total_questions: packageData.metadata?.total_questions || 0,
      total_images: packageData.metadata?.total_images || 0
    };
  }

  /**
   * Reset validator
   */
  reset() {
    this.currentAgenda = null;
    this.participants.clear();
    this.validTokens.clear();
    this.agendaTimeValid = false;
  }

  /**
   * Health check
   */
  async healthCheck() {
    try {
      const stats = await this.cache.getStats();
      const packageData = await this.cache.getExamPackage(this.currentAgenda?.id);
      
      return {
        initialized: !!this.currentAgenda,
        agenda_id: this.currentAgenda?.id || null,
        agenda_name: this.currentAgenda?.agenda_ujian || null,
        participants_loaded: this.participants.size,
        cache_stats: stats,
        package_exists: !!packageData,
        time_valid: this.agendaTimeValid,
        status: 'healthy'
      };
    } catch (error) {
      return {
        initialized: !!this.currentAgenda,
        status: 'error',
        error: error.message
      };
    }
  }
}

// Export for browser
if (typeof window !== 'undefined') {
  window.OfflineValidator = OfflineValidator;
}
