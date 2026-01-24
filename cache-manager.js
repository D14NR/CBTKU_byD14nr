// cache-manager.js
class CacheManager {
  constructor() {
    this.cache = {
      user: null,
      agenda: null,
      mapels: new Map(),
      soal: new Map(),
      jawaban: new Map(),
      waktuMulai: new Map(),
      settings: {}
    };
    
    this.syncQueue = [];
    this.isOnline = navigator.onLine;
    this.db = null;
    this.init();
  }
  
  async init() {
    // Load from localStorage
    this.loadFromStorage();
    
    // Setup event listeners
    this.setupEventListeners();
    
    // Setup IndexedDB for large data
    await this.setupIndexedDB();
    
    // Sync on start if online
    if (this.isOnline) {
      setTimeout(() => this.syncAll(), 2000);
    }
  }
  
  setupEventListeners() {
    window.addEventListener('online', () => {
      this.isOnline = true;
      console.log('[CacheManager] Online, syncing...');
      this.syncAll();
      this.showNotification('Koneksi pulih. Menyinkronkan data...', 'info');
    });
    
    window.addEventListener('offline', () => {
      this.isOnline = false;
      console.log('[CacheManager] Offline mode');
      this.showNotification('Anda offline. Jawaban disimpan lokal.', 'warning');
    });
    
    // Beforeunload - backup data
    window.addEventListener('beforeunload', () => {
      this.saveToStorage();
    });
    
    // Periodic save
    setInterval(() => this.saveToStorage(), 30000);
  }
  
  async setupIndexedDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('CBTUjianDB', 1);
      
      request.onerror = () => {
        console.error('[CacheManager] IndexedDB error:', request.error);
        resolve(false);
      };
      
      request.onsuccess = (event) => {
        this.db = event.target.result;
        console.log('[CacheManager] IndexedDB initialized');
        resolve(true);
      };
      
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        
        // Store for jawaban
        if (!db.objectStoreNames.contains('jawaban')) {
          const jawabanStore = db.createObjectStore('jawaban', { keyPath: 'id' });
          jawabanStore.createIndex('mapelId', 'mapelId', { unique: false });
          jawabanStore.createIndex('timestamp', 'timestamp', { unique: false });
        }
        
        // Store for soal
        if (!db.objectStoreNames.contains('soal')) {
          const soalStore = db.createObjectStore('soal', { keyPath: 'id' });
          soalStore.createIndex('mapelId', 'mapelId', { unique: false });
        }
        
        // Store for sync queue
        if (!db.objectStoreNames.contains('syncQueue')) {
          const syncStore = db.createObjectStore('syncQueue', { 
            keyPath: 'id',
            autoIncrement: true 
          });
          syncStore.createIndex('type', 'type', { unique: false });
          syncStore.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };
    });
  }
  
  // ==================== CACHE OPERATIONS ====================
  
  async cacheUserData(userData) {
    this.cache.user = userData;
    
    // Save to localStorage
    localStorage.setItem('cached_user', JSON.stringify(userData));
    
    // Save to IndexedDB
    await this.saveToIndexedDB('user', userData);
    
    console.log('[CacheManager] User data cached:', userData.id);
    return true;
  }
  
  async cacheAgenda(agendaData) {
    this.cache.agenda = agendaData;
    localStorage.setItem('cached_agenda', JSON.stringify(agendaData));
    return true;
  }
  
  async cacheMapels(mapels, agendaId) {
    const key = `mapels_${agendaId}`;
    this.cache.mapels.set(agendaId, mapels);
    localStorage.setItem(key, JSON.stringify(mapels));
    
    // Prefetch soal untuk mapel yang belum selesai
    for (const mapel of mapels) {
      if (mapel.status_kerjakan !== 'Selesai') {
        this.prefetchSoal(mapel.id);
      }
    }
    
    return true;
  }
  
  async prefetchSoal(mapelId) {
    try {
      const cacheKey = `soal_${mapelId}`;
      
      // Check if already cached
      if (this.cache.soal.has(mapelId)) {
        return this.cache.soal.get(mapelId);
      }
      
      // Check localStorage
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        const data = JSON.parse(cached);
        this.cache.soal.set(mapelId, data);
        return data;
      }
      
      // Fetch from server if online
      if (this.isOnline && this.cache.user) {
        const response = await fetch(`${API_URL}/get-soal`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agenda_id: this.cache.user.id_agenda,
            peserta_id: this.cache.user.id,
            mapel_id: mapelId
          })
        });
        
        if (response.ok) {
          const data = await response.json();
          
          if (data.success) {
            // Cache in memory
            this.cache.soal.set(mapelId, data);
            
            // Cache in localStorage
            localStorage.setItem(cacheKey, JSON.stringify(data));
            
            // Cache in IndexedDB
            await this.saveToIndexedDB('soal', {
              id: mapelId,
              data: data,
              timestamp: Date.now()
            });
            
            // Precache images
            this.precacheImages(data);
            
            console.log(`[CacheManager] Soal prefetched: ${mapelId}`);
            return data;
          }
        }
      }
      
      return null;
    } catch (error) {
      console.error('[CacheManager] Prefetch error:', error);
      return null;
    }
  }
  
  async precacheImages(soalData) {
    if (!soalData.data_soal) return;
    
    const imageUrls = [];
    
    soalData.data_soal.forEach(question => {
      if (question.gambar_url) {
        imageUrls.push(question.gambar_url);
      }
    });
    
    if (imageUrls.length === 0) return;
    
    // Use cache API to precache images
    const cache = await caches.open('image-cache');
    
    imageUrls.forEach(url => {
      cache.add(url).catch(() => {});
    });
    
    console.log(`[CacheManager] ${imageUrls.length} images precached`);
  }
  
  async getSoal(mapelId) {
    // 1. Check memory cache
    if (this.cache.soal.has(mapelId)) {
      const data = this.cache.soal.get(mapelId);
      return { ...data, source: 'memory' };
    }
    
    // 2. Check localStorage
    const cacheKey = `soal_${mapelId}`;
    const cached = localStorage.getItem(cacheKey);
    
    if (cached) {
      try {
        const data = JSON.parse(cached);
        this.cache.soal.set(mapelId, data);
        return { ...data, source: 'localStorage' };
      } catch (error) {
        console.error('[CacheManager] Parse cached soal error:', error);
      }
    }
    
    // 3. Check IndexedDB
    const dbData = await this.getFromIndexedDB('soal', mapelId);
    if (dbData) {
      this.cache.soal.set(mapelId, dbData.data);
      return { ...dbData.data, source: 'indexedDB' };
    }
    
    // 4. Return null (need to fetch)
    return null;
  }
  
  // ==================== JAWABAN MANAGEMENT ====================
  
  async saveJawaban(mapelId, jawabanData) {
    const id = `${mapelId}_${Date.now()}`;
    const data = {
      id,
      mapelId,
      jawabanData,
      timestamp: Date.now(),
      synced: false
    };
    
    // Save to memory cache
    this.cache.jawaban.set(mapelId, data);
    
    // Save to localStorage (for quick access)
    localStorage.setItem(`jawaban_${mapelId}`, JSON.stringify(jawabanData));
    
    // Save to IndexedDB (for persistence)
    await this.saveToIndexedDB('jawaban', data);
    
    // Add to sync queue
    await this.addToSyncQueue({
      type: 'save_jawaban',
      data: { mapelId, jawabanData },
      timestamp: Date.now()
    });
    
    // Auto sync if online
    if (this.isOnline) {
      await this.syncJawaban(mapelId, jawabanData);
    }
    
    console.log(`[CacheManager] Jawaban saved for ${mapelId}`);
    return id;
  }
  
  async getJawaban(mapelId) {
    // Check memory cache first
    if (this.cache.jawaban.has(mapelId)) {
      return this.cache.jawaban.get(mapelId).jawabanData;
    }
    
    // Check localStorage
    const cached = localStorage.getItem(`jawaban_${mapelId}`);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch (error) {
        console.error('[CacheManager] Parse jawaban error:', error);
      }
    }
    
    // Check IndexedDB
    const dbData = await this.getFromIndexedDB('jawaban', mapelId, 'mapelId');
    if (dbData) {
      return dbData.jawabanData;
    }
    
    return null;
  }
  
  async saveWaktuMulai(mapelId, waktuMulai) {
    this.cache.waktuMulai.set(mapelId, waktuMulai);
    localStorage.setItem(`waktu_${mapelId}`, waktuMulai);
    return true;
  }
  
  async getWaktuMulai(mapelId) {
    if (this.cache.waktuMulai.has(mapelId)) {
      return this.cache.waktuMulai.get(mapelId);
    }
    
    const cached = localStorage.getItem(`waktu_${mapelId}`);
    return cached || null;
  }
  
  // ==================== SYNC MANAGEMENT ====================
  
  async addToSyncQueue(item) {
    if (!this.db) return;
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['syncQueue'], 'readwrite');
      const store = transaction.objectStore('syncQueue');
      
      const request = store.add({
        ...item,
        timestamp: Date.now(),
        attempts: 0
      });
      
      request.onsuccess = () => {
        this.syncQueue.push(item);
        resolve(request.result);
      };
      
      request.onerror = () => {
        reject(request.error);
      };
    });
  }
  
  async syncAll() {
    if (!this.isOnline) return;
    
    console.log('[CacheManager] Starting sync...');
    
    // Sync jawaban
    await this.syncPendingJawaban();
    
    // Sync other pending items
    await this.processSyncQueue();
    
    console.log('[CacheManager] Sync completed');
  }
  
  async syncPendingJawaban() {
    try {
      // Get unsynced jawaban from IndexedDB
      const unsynced = await this.getUnsyncedJawaban();
      
      for (const item of unsynced) {
        await this.syncJawaban(item.mapelId, item.jawabanData);
        await this.markAsSynced(item.id);
      }
    } catch (error) {
      console.error('[CacheManager] Sync jawaban error:', error);
    }
  }
  
  async syncJawaban(mapelId, jawabanData) {
    if (!this.isOnline || !this.cache.user) return false;
    
    try {
      const response = await fetch(`${API_URL}/save-jawaban`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pid: this.cache.user.id,
          aid: this.cache.user.id_agenda,
          mid: mapelId,
          jwb: jawabanData.jawabanString
        })
      });
      
      const result = await response.json();
      
      if (result.success) {
        console.log(`[CacheManager] Jawaban synced: ${mapelId}`);
        return true;
      }
      
      return false;
    } catch (error) {
      console.error('[CacheManager] Sync error:', error);
      return false;
    }
  }
  
  async finishExam(mapelId, jawabanData) {
    const cacheKey = `exam_final_${mapelId}`;
    
    // Save final answer locally
    await this.saveToIndexedDB('jawaban', {
      id: `final_${mapelId}`,
      mapelId,
      jawabanData: {
        ...jawabanData,
        isFinal: true,
        finishedAt: Date.now()
      },
      timestamp: Date.now(),
      synced: false
    });
    
    // Add to sync queue
    await this.addToSyncQueue({
      type: 'finish_exam',
      data: { mapelId, jawabanData },
      timestamp: Date.now()
    });
    
    // Try to submit if online
    if (this.isOnline) {
      return await this.submitFinalExam(mapelId, jawabanData);
    }
    
    return {
      success: true,
      offline: true,
      message: 'Ujian diselesaikan offline. Akan dikirim saat online.'
    };
  }
  
  async submitFinalExam(mapelId, jawabanData) {
    try {
      const response = await fetch(`${API_URL}/selesai-ujian`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pid: this.cache.user.id,
          aid: this.cache.user.id_agenda,
          mid: mapelId,
          jwb: jawabanData.jawabanString
        })
      });
      
      const result = await response.json();
      
      if (result.success) {
        // Clear cache for this exam
        this.clearExamCache(mapelId);
      }
      
      return result;
    } catch (error) {
      throw error;
    }
  }
  
  // ==================== STORAGE MANAGEMENT ====================
  
  loadFromStorage() {
    try {
      // Load user
      const user = localStorage.getItem('cached_user');
      if (user) this.cache.user = JSON.parse(user);
      
      // Load agenda
      const agenda = localStorage.getItem('cached_agenda');
      if (agenda) this.cache.agenda = JSON.parse(agenda);
      
      // Load mapels
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key.startsWith('mapels_')) {
          const agendaId = key.replace('mapels_', '');
          const mapels = JSON.parse(localStorage.getItem(key));
          this.cache.mapels.set(agendaId, mapels);
        }
      }
      
      console.log('[CacheManager] Loaded from storage');
    } catch (error) {
      console.error('[CacheManager] Load from storage error:', error);
    }
  }
  
  saveToStorage() {
    try {
      if (this.cache.user) {
        localStorage.setItem('cached_user', JSON.stringify(this.cache.user));
      }
      
      if (this.cache.agenda) {
        localStorage.setItem('cached_agenda', JSON.stringify(this.cache.agenda));
      }
      
      // Save cache timestamp
      localStorage.setItem('cache_timestamp', Date.now().toString());
      
      console.log('[CacheManager] Saved to storage');
    } catch (error) {
      console.error('[CacheManager] Save to storage error:', error);
    }
  }
  
  async saveToIndexedDB(storeName, data) {
    if (!this.db) return;
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      
      const request = store.put(data);
      
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  
  async getFromIndexedDB(storeName, key, indexName = null) {
    if (!this.db) return null;
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName]);
      const store = transaction.objectStore(storeName);
      
      let request;
      
      if (indexName) {
        const index = store.index(indexName);
        request = index.get(key);
      } else {
        request = store.get(key);
      }
      
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  
  // ==================== UTILITIES ====================
  
  clearExamCache(mapelId) {
    // Clear memory cache
    this.cache.soal.delete(mapelId);
    this.cache.jawaban.delete(mapelId);
    this.cache.waktuMulai.delete(mapelId);
    
    // Clear localStorage
    localStorage.removeItem(`soal_${mapelId}`);
    localStorage.removeItem(`jawaban_${mapelId}`);
    localStorage.removeItem(`waktu_${mapelId}`);
    
    // Clear IndexedDB
    this.clearFromIndexedDB('soal', mapelId);
    this.clearFromIndexedDB('jawaban', mapelId, 'mapelId');
    
    console.log(`[CacheManager] Cache cleared for ${mapelId}`);
  }
  
  async clearFromIndexedDB(storeName, key, indexName = null) {
    if (!this.db) return;
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      
      let request;
      
      if (indexName) {
        const index = store.index(indexName);
        request = index.openCursor(IDBKeyRange.only(key));
        
        request.onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          } else {
            resolve(true);
          }
        };
      } else {
        request = store.delete(key);
        
        request.onsuccess = () => resolve(true);
      }
      
      request.onerror = () => reject(request.error);
    });
  }
  
  async getUnsyncedJawaban() {
    if (!this.db) return [];
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['jawaban']);
      const store = transaction.objectStore('jawaban');
      const index = store.index('timestamp');
      
      const request = index.getAll();
      
      request.onsuccess = (event) => {
        const results = event.target.result || [];
        const unsynced = results.filter(item => !item.synced);
        resolve(unsynced);
      };
      
      request.onerror = () => reject(request.error);
    });
  }
  
  async markAsSynced(id) {
    if (!this.db) return;
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['jawaban'], 'readwrite');
      const store = transaction.objectStore('jawaban');
      
      const request = store.get(id);
      
      request.onsuccess = (event) => {
        const data = event.target.result;
        if (data) {
          data.synced = true;
          store.put(data);
          resolve(true);
        } else {
          resolve(false);
        }
      };
      
      request.onerror = () => reject(request.error);
    });
  }
  
  async processSyncQueue() {
    if (!this.db) return;
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['syncQueue'], 'readwrite');
      const store = transaction.objectStore('syncQueue');
      const index = store.index('timestamp');
      
      const request = index.openCursor();
      const itemsToProcess = [];
      
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          itemsToProcess.push(cursor.value);
          cursor.continue();
        } else {
          this.processQueueItems(itemsToProcess).then(resolve).catch(reject);
        }
      };
      
      request.onerror = () => reject(request.error);
    });
  }
  
  async processQueueItems(items) {
    for (const item of items) {
      try {
        await this.processQueueItem(item);
        await this.removeFromSyncQueue(item.id);
      } catch (error) {
        console.error('[CacheManager] Process queue item error:', error);
        item.attempts = (item.attempts || 0) + 1;
        
        if (item.attempts < 3) {
          await this.updateSyncQueueItem(item);
        }
      }
    }
  }
  
  async processQueueItem(item) {
    switch (item.type) {
      case 'save_jawaban':
        await this.syncJawaban(item.data.mapelId, item.data.jawabanData);
        break;
      case 'finish_exam':
        await this.submitFinalExam(item.data.mapelId, item.data.jawabanData);
        break;
    }
  }
  
  async removeFromSyncQueue(id) {
    if (!this.db) return;
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['syncQueue'], 'readwrite');
      const store = transaction.objectStore('syncQueue');
      
      const request = store.delete(id);
      
      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(request.error);
    });
  }
  
  async updateSyncQueueItem(item) {
    if (!this.db) return;
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['syncQueue'], 'readwrite');
      const store = transaction.objectStore('syncQueue');
      
      const request = store.put(item);
      
      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(request.error);
    });
  }
  
  getCacheStatus() {
    const stats = {
      user: !!this.cache.user,
      agenda: !!this.cache.agenda,
      mapels: this.cache.mapels.size,
      soal: this.cache.soal.size,
      jawaban: this.cache.jawaban.size,
      isOnline: this.isOnline,
      storage: {
        localStorage: this.getLocalStorageSize(),
        memory: this.getMemoryUsage()
      },
      timestamp: Date.now()
    };
    
    return stats;
  }
  
  getLocalStorageSize() {
    let total = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const value = localStorage.getItem(key);
      total += key.length + (value ? value.length : 0);
    }
    return total;
  }
  
  getMemoryUsage() {
    const data = {
      user: this.cache.user,
      agenda: this.cache.agenda,
      mapels: Array.from(this.cache.mapels.entries()),
      soal: Array.from(this.cache.soal.entries()),
      jawaban: Array.from(this.cache.jawaban.entries())
    };
    
    const json = JSON.stringify(data);
    return json.length;
  }
  
  showNotification(message, type = 'info') {
    if (window.showToast) {
      window.showToast(message, type);
    } else {
      console.log(`[CacheManager] ${type}: ${message}`);
    }
  }
  
  // Cleanup old cache
  async cleanupOldCache(maxAge = 7 * 24 * 60 * 60 * 1000) { // 7 days
    const now = Date.now();
    
    // Clean localStorage
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key.startsWith('soal_') || key.startsWith('jawaban_')) {
        try {
          const item = JSON.parse(localStorage.getItem(key));
          if (item && now - (item.timestamp || 0) > maxAge) {
            localStorage.removeItem(key);
          }
        } catch (error) {
          // Skip if can't parse
        }
      }
    }
    
    console.log('[CacheManager] Old cache cleaned');
  }
}

// Global instance
window.cacheManager = new CacheManager();
