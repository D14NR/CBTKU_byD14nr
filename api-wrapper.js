// api-wrapper.js - Cache First Strategy
class CacheFirstAPI {
  constructor() {
    this.cacheManager = window.cacheManager;
    this.apiUrl = API_URL;
  }
  
  async login(username, password) {
    try {
      // API call
      const response = await fetch(`${this.apiUrl}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ u: username, p: password })
      });
      
      const result = await response.json();
      
      if (result.success) {
        // Cache all user data
        await this.cacheManager.cacheUserData(result.data);
        
        // Cache agenda
        if (result.data.id_agenda) {
          await this.prefetchAllData(result.data);
        }
        
        return {
          ...result,
          cacheStatus: this.cacheManager.getCacheStatus()
        };
      }
      
      return result;
    } catch (error) {
      console.error('Login error:', error);
      throw error;
    }
  }
  
  async prefetchAllData(userData) {
    try {
      // 1. Get agenda
      const agendaResponse = await fetch(`${this.apiUrl}/agenda`);
      const agendaData = await agendaResponse.json();
      
      if (agendaData.success) {
        const userAgenda = agendaData.data.find(a => a.id == userData.id_agenda);
        if (userAgenda) {
          await this.cacheManager.cacheAgenda(userAgenda);
        }
      }
      
      // 2. Get mapels
      const mapelResponse = await fetch(
        `${this.apiUrl}/mapel?agenda_id=${userData.id_agenda}&peserta_id=${userData.id}`
      );
      const mapelData = await mapelResponse.json();
      
      if (mapelData.success) {
        await this.cacheManager.cacheMapels(mapelData.data, userData.id_agenda);
      }
      
      console.log('[API] Prefetch completed');
      return true;
    } catch (error) {
      console.error('Prefetch error:', error);
      return false;
    }
  }
  
  async getAgenda() {
    // Try cache first
    const cached = this.cacheManager.cache.agenda;
    if (cached) {
      return {
        success: true,
        data: cached,
        fromCache: true
      };
    }
    
    // Fetch from server
    try {
      const response = await fetch(`${this.apiUrl}/agenda`);
      const data = await response.json();
      
      if (data.success) {
        // Cache the data
        this.cacheManager.cache.agenda = data.data[0];
      }
      
      return data;
    } catch (error) {
      throw error;
    }
  }
  
  async getMapel() {
    if (!this.cacheManager.cache.user) {
      throw new Error('User not logged in');
    }
    
    const agendaId = this.cacheManager.cache.user.id_agenda;
    
    // Try cache first
    if (this.cacheManager.cache.mapels.has(agendaId)) {
      const cached = this.cacheManager.cache.mapels.get(agendaId);
      return {
        success: true,
        data: cached,
        fromCache: true,
        cachedAt: Date.now()
      };
    }
    
    // Fetch from server
    try {
      const response = await fetch(
        `${this.apiUrl}/mapel?agenda_id=${agendaId}&peserta_id=${this.cacheManager.cache.user.id}`
      );
      
      const data = await response.json();
      
      if (data.success) {
        // Cache the data
        await this.cacheManager.cacheMapels(data.data, agendaId);
      }
      
      return data;
    } catch (error) {
      throw error;
    }
  }
  
  async getSoal(mapelId, forceRefresh = false) {
    // Try cache first (unless force refresh)
    if (!forceRefresh) {
      const cached = await this.cacheManager.getSoal(mapelId);
      if (cached) {
        return {
          ...cached,
          fromCache: true,
          cached: true
        };
      }
    }
    
    // Fetch from server
    try {
      if (!this.cacheManager.cache.user) {
        throw new Error('User not logged in');
      }
      
      const response = await fetch(`${this.apiUrl}/get-soal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agenda_id: this.cacheManager.cache.user.id_agenda,
          peserta_id: this.cacheManager.cache.user.id,
          mapel_id: mapelId
        })
      });
      
      const data = await response.json();
      
      if (data.success) {
        // Cache the data
        this.cacheManager.cache.soal.set(mapelId, data);
        
        // Save to localStorage
        localStorage.setItem(`soal_${mapelId}`, JSON.stringify(data));
        
        // Save to IndexedDB
        await this.cacheManager.saveToIndexedDB('soal', {
          id: mapelId,
          data: data,
          timestamp: Date.now()
        });
        
        // Precache images
        this.cacheManager.precacheImages(data);
      }
      
      return data;
    } catch (error) {
      console.error('Get soal error:', error);
      
      // If offline and no cache, throw error
      if (!this.cacheManager.isOnline) {
        const cached = await this.cacheManager.getSoal(mapelId);
        if (cached) {
          return {
            ...cached,
            fromCache: true,
            offline: true
          };
        }
      }
      
      throw error;
    }
  }
  
  async saveJawaban(mapelId, jawabanString) {
    // Save to cache immediately
    const jawabanData = {
      jawabanString,
      savedAt: Date.now(),
      mapelId
    };
    
    await this.cacheManager.saveJawaban(mapelId, jawabanData);
    
    // If online, sync to server
    if (this.cacheManager.isOnline) {
      try {
        const response = await fetch(`${this.apiUrl}/save-jawaban`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pid: this.cacheManager.cache.user.id,
            aid: this.cacheManager.cache.user.id_agenda,
            mid: mapelId,
            jwb: jawabanString
          })
        });
        
        const result = await response.json();
        
        if (result.success) {
          // Mark as synced
          // This would update the cache item's synced status
          return {
            ...result,
            synced: true,
            cached: true
          };
        }
        
        return result;
      } catch (error) {
        console.error('Save jawaban error:', error);
        return {
          success: true,
          synced: false,
          cached: true,
          message: 'Disimpan lokal, akan sync nanti'
        };
      }
    }
    
    return {
      success: true,
      synced: false,
      cached: true,
      offline: true,
      message: 'Disimpan offline'
    };
  }
  
  async selesaiUjian(mapelId, jawabanString) {
    const jawabanData = {
      jawabanString,
      submittedAt: Date.now(),
      isFinal: true
    };
    
    return await this.cacheManager.finishExam(mapelId, jawabanData);
  }
  
  async verifyToken(agendaId, token) {
    try {
      const response = await fetch(`${this.apiUrl}/verify-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agenda_id: agendaId,
          token: token
        })
      });
      
      return await response.json();
    } catch (error) {
      throw error;
    }
  }
  
  async register(formData) {
    try {
      const response = await fetch(`${this.apiUrl}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      });
      
      const result = await response.json();
      
      if (result.success) {
        // Cache user data
        await this.cacheManager.cacheUserData(result.data);
      }
      
      return result;
    } catch (error) {
      throw error;
    }
  }
  
  async forgotPassword(username) {
    try {
      const response = await fetch(`${this.apiUrl}/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username })
      });
      
      return await response.json();
    } catch (error) {
      throw error;
    }
  }
  
  async verifyOTP(userId, otp) {
    try {
      const response = await fetch(`${this.apiUrl}/verify-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, otp })
      });
      
      return await response.json();
    } catch (error) {
      throw error;
    }
  }
  
  async resetPassword(resetToken, newPassword, confirmPassword) {
    try {
      const response = await fetch(`${this.apiUrl}/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reset_token: resetToken,
          new_password: newPassword,
          confirm_password: confirmPassword
        })
      });
      
      return await response.json();
    } catch (error) {
      throw error;
    }
  }
}

// Global instance
window.apiWrapper = new CacheFirstAPI();
