/**
 * CACHE MANAGER untuk CBTKU Offline Mode
 * Menggunakan IndexedDB untuk menyimpan data ujian
 */
class ExamCacheManager {
  constructor() {
    this.db = null;
    this.dbName = 'ExamCacheDB';
    this.dbVersion = 3;
    this.maxCacheSize = 50 * 1024 * 1024; // 50MB
  }

  /**
   * Initialize IndexedDB
   */
  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onerror = (event) => {
        console.error('IndexedDB error:', event.target.error);
        reject(new Error('Tidak bisa mengakses database lokal'));
      };

      request.onupgradeneeded = (event) => {
        this.db = event.target.result;
        this.createObjectStores();
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        
        // Set up error handling
        this.db.onerror = (event) => {
          console.error('Database error:', event.target.error);
        };
        
        // Clean old cache
        this.cleanupOldCache().then(resolve).catch(resolve);
      };
    });
  }

  /**
   * Create object stores
   */
  createObjectStores() {
    // Store untuk exam packages
    if (!this.db.objectStoreNames.contains('exam_packages')) {
      const packageStore = this.db.createObjectStore('exam_packages', { keyPath: 'agenda_id' });
      packageStore.createIndex('updated_at', 'updated_at');
      packageStore.createIndex('size', 'size');
    }

    // Store untuk questions
    if (!this.db.objectStoreNames.contains('questions')) {
      const questionStore = this.db.createObjectStore('questions', { 
        keyPath: ['agenda_id', 'mapel_id', 'id'] 
      });
      questionStore.createIndex('agenda_mapel', ['agenda_id', 'mapel_id']);
      questionStore.createIndex('last_accessed', 'last_accessed');
    }

    // Store untuk temporary answers
    if (!this.db.objectStoreNames.contains('temp_answers')) {
      const answerStore = this.db.createObjectStore('temp_answers', { 
        keyPath: ['agenda_id', 'mapel_id', 'question_id'] 
      });
      answerStore.createIndex('agenda_mapel', ['agenda_id', 'mapel_id']);
      answerStore.createIndex('timestamp', 'timestamp');
    }

    // Store untuk images
    if (!this.db.objectStoreNames.contains('images')) {
      const imageStore = this.db.createObjectStore('images', { keyPath: 'url' });
      imageStore.createIndex('last_accessed', 'last_accessed');
      imageStore.createIndex('size', 'size');
    }

    // Store untuk submission queue
    if (!this.db.objectStoreNames.contains('submission_queue')) {
      const queueStore = this.db.createObjectStore('submission_queue', { 
        keyPath: 'id',
        autoIncrement: true 
      });
      queueStore.createIndex('status', 'status');
      queueStore.createIndex('created_at', 'created_at');
    }

    // Store untuk session data
    if (!this.db.objectStoreNames.contains('sessions')) {
      const sessionStore = this.db.createObjectStore('sessions', { keyPath: 'session_id' });
      sessionStore.createIndex('expires_at', 'expires_at');
    }
  }

  /**
   * Save exam package to cache
   */
  async saveExamPackage(agendaId, packageData) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['exam_packages', 'questions', 'sessions'], 'readwrite');
      
      // 1. Save package metadata
      const packageSize = JSON.stringify(packageData).length;
      const packageStore = tx.objectStore('exam_packages');
      
      packageStore.put({
        agenda_id: agendaId,
        data: packageData,
        downloaded_at: new Date().toISOString(),
        updated_at: Date.now(),
        size: packageSize,
        version: packageData.metadata?.package_version || '1.0'
      });

      // 2. Save all questions
      const questionStore = tx.objectStore('questions');
      Object.keys(packageData.questions_by_mapel || {}).forEach(mapelId => {
        packageData.questions_by_mapel[mapelId].forEach(question => {
          questionStore.put({
            agenda_id: agendaId,
            mapel_id: mapelId,
            id: question.id,
            no_soal: question.no_soal,
            type_soal: question.type_soal,
            pertanyaan: question.pertanyaan,
            gambar_url: question.gambar_url,
            pilihan_a: question.pilihan_a,
            pilihan_b: question.pilihan_b,
            pilihan_c: question.pilihan_c,
            pilihan_d: question.pilihan_d,
            pilihan_e: question.pilihan_e,
            pernyataan_1: question.pernyataan_1,
            pernyataan_2: question.pernyataan_2,
            pernyataan_3: question.pernyataan_3,
            pernyataan_4: question.pernyataan_4,
            pernyataan_5: question.pernyataan_5,
            pernyataan_6: question.pernyataan_6,
            pernyataan_7: question.pernyataan_7,
            pernyataan_8: question.pernyataan_8,
            pernyataan_kiri_1: question.pernyataan_kiri_1,
            pernyataan_kiri_2: question.pernyataan_kiri_2,
            pernyataan_kiri_3: question.pernyataan_kiri_3,
            pernyataan_kiri_4: question.pernyataan_kiri_4,
            pernyataan_kiri_5: question.pernyataan_kiri_5,
            pernyataan_kiri_6: question.pernyataan_kiri_6,
            pernyataan_kiri_7: question.pernyataan_kiri_7,
            pernyataan_kiri_8: question.pernyataan_kiri_8,
            pernyataan_kanan_1: question.pernyataan_kanan_1,
            pernyataan_kanan_2: question.pernyataan_kanan_2,
            pernyataan_kanan_3: question.pernyataan_kanan_3,
            pernyataan_kanan_4: question.pernyataan_kanan_4,
            pernyataan_kanan_5: question.pernyataan_kanan_5,
            pernyataan_kanan_6: question.pernyataan_kanan_6,
            pernyataan_kanan_7: question.pernyataan_kanan_7,
            pernyataan_kanan_8: question.pernyataan_kanan_8,
            last_accessed: Date.now()
          });
        });
      });

      // 3. Save session
      const sessionStore = tx.objectStore('sessions');
      sessionStore.put({
        session_id: `agenda_${agendaId}`,
        agenda_id: agendaId,
        package_data: packageData,
        created_at: new Date().toISOString(),
        expires_at: packageData.agenda?.tgljam_selesai || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      });

      tx.oncomplete = () => {
        console.log(`Package saved: ${agendaId}, ${packageSize} bytes`);
        resolve(true);
      };

      tx.onerror = (event) => {
        console.error('Save package error:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  /**
   * Get exam package from cache
   */
  async getExamPackage(agendaId) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('exam_packages', 'readonly');
      const store = tx.objectStore('exam_packages');
      const request = store.get(agendaId);

      request.onsuccess = () => {
        if (request.result) {
          // Update last accessed
          this.updatePackageAccessTime(agendaId);
          resolve(request.result.data);
        } else {
          resolve(null);
        }
      };

      request.onerror = (event) => reject(event.target.error);
    });
  }

  /**
   * Check if package exists
   */
  async hasExamPackage(agendaId) {
    const packageData = await this.getExamPackage(agendaId);
    return !!packageData;
  }

  /**
   * Get questions by mapel
   */
  async getQuestionsByMapel(agendaId, mapelId) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('questions', 'readonly');
      const store = tx.objectStore('questions');
      const index = store.index('agenda_mapel');
      
      const range = IDBKeyRange.bound(
        [agendaId, mapelId],
        [agendaId, mapelId]
      );
      
      const request = index.getAll(range);

      request.onsuccess = () => {
        const questions = request.result || [];
        
        // Sort by no_soal
        questions.sort((a, b) => {
          const aNo = parseInt(a.no_soal) || 0;
          const bNo = parseInt(b.no_soal) || 0;
          return aNo - bNo;
        });
        
        // Update access time
        this.updateQuestionsAccessTime(agendaId, mapelId);
        
        resolve(questions);
      };

      request.onerror = (event) => reject(event.target.error);
    });
  }

  /**
   * Get single question
   */
  async getQuestion(agendaId, mapelId, questionId) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('questions', 'readonly');
      const store = tx.objectStore('questions');
      const request = store.get([agendaId, mapelId, questionId]);

      request.onsuccess = () => {
        if (request.result) {
          // Update access time
          this.updateQuestionAccessTime(agendaId, mapelId, questionId);
          resolve(request.result);
        } else {
          resolve(null);
        }
      };

      request.onerror = (event) => reject(event.target.error);
    });
  }

  /**
   * Save temporary answer
   */
  async saveAnswer(agendaId, mapelId, questionId, answer) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('temp_answers', 'readwrite');
      const store = tx.objectStore('temp_answers');
      
      store.put({
        agenda_id: agendaId,
        mapel_id: mapelId,
        question_id: questionId,
        answer: answer,
        timestamp: Date.now(),
        synced: false
      });

      tx.oncomplete = () => resolve();
      tx.onerror = (event) => reject(event.target.error);
    });
  }

  /**
   * Get all answers for a mapel
   */
  async getAllAnswers(agendaId, mapelId) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('temp_answers', 'readonly');
      const store = tx.objectStore('temp_answers');
      const index = store.index('agenda_mapel');
      
      const range = IDBKeyRange.bound(
        [agendaId, mapelId],
        [agendaId, mapelId]
      );
      
      const request = index.getAll(range);

      request.onsuccess = () => {
        const answers = {};
        (request.result || []).forEach(item => {
          answers[item.question_id] = item.answer;
        });
        resolve(answers);
      };

      request.onerror = (event) => reject(event.target.error);
    });
  }

  /**
   * Get unsynced answers
   */
  async getUnsyncedAnswers(agendaId, mapelId) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('temp_answers', 'readonly');
      const store = tx.objectStore('temp_answers');
      const index = store.index('agenda_mapel');
      
      const range = IDBKeyRange.bound(
        [agendaId, mapelId],
        [agendaId, mapelId]
      );
      
      const request = index.openCursor(range);

      const unsynced = {};
      
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          if (!cursor.value.synced) {
            unsynced[cursor.value.question_id] = cursor.value.answer;
          }
          cursor.continue();
        } else {
          resolve(unsynced);
        }
      };

      request.onerror = (event) => reject(event.target.error);
    });
  }

  /**
   * Mark answers as synced
   */
  async markAnswersAsSynced(agendaId, mapelId, questionIds) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('temp_answers', 'readwrite');
      const store = tx.objectStore('temp_answers');
      
      questionIds.forEach(questionId => {
        const request = store.get([agendaId, mapelId, questionId]);
        
        request.onsuccess = () => {
          if (request.result) {
            request.result.synced = true;
            store.put(request.result);
          }
        };
      });

      tx.oncomplete = () => resolve();
      tx.onerror = (event) => reject(event.target.error);
    });
  }

  /**
   * Clear answers for a mapel
   */
  async clearAnswers(agendaId, mapelId) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('temp_answers', 'readwrite');
      const store = tx.objectStore('temp_answers');
      const index = store.index('agenda_mapel');
      
      const range = IDBKeyRange.bound(
        [agendaId, mapelId],
        [agendaId, mapelId]
      );
      
      const request = index.openCursor(range);

      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else {
          resolve();
        }
      };

      request.onerror = (event) => reject(event.target.error);
    });
  }

  /**
   * Cache image
   */
  async cacheImage(url, blob) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('images', 'readwrite');
      const store = tx.objectStore('images');
      
      store.put({
        url: url,
        blob: blob,
        size: blob.size,
        cached_at: Date.now(),
        last_accessed: Date.now(),
        content_type: blob.type
      });

      tx.oncomplete = () => resolve();
      tx.onerror = (event) => reject(event.target.error);
    });
  }

  /**
   * Get cached image
   */
  async getCachedImage(url) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('images', 'readonly');
      const store = tx.objectStore('images');
      const request = store.get(url);

      request.onsuccess = () => {
        if (request.result) {
          // Update last accessed
          this.updateImageAccessTime(url);
          
          // Create object URL
          const objectUrl = URL.createObjectURL(request.result.blob);
          resolve({
            url: objectUrl,
            blob: request.result.blob,
            cached_at: request.result.cached_at,
            size: request.result.size
          });
        } else {
          resolve(null);
        }
      };

      request.onerror = (event) => reject(event.target.error);
    });
  }

  /**
   * Queue submission for retry
   */
  async queueSubmission(submissionData) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('submission_queue', 'readwrite');
      const store = tx.objectStore('submission_queue');
      
      store.put({
        ...submissionData,
        status: 'pending',
        created_at: new Date().toISOString(),
        retry_count: 0,
        last_retry: null
      });

      tx.oncomplete = () => resolve();
      tx.onerror = (event) => reject(event.target.error);
    });
  }

  /**
   * Get pending submissions
   */
  async getPendingSubmissions() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('submission_queue', 'readonly');
      const store = tx.objectStore('submission_queue');
      const index = store.index('status');
      
      const request = index.getAll('pending');

      request.onsuccess = () => resolve(request.result || []);
      request.onerror = (event) => reject(event.target.error);
    });
  }

  /**
   * Update submission status
   */
  async updateSubmissionStatus(submissionId, status, error = null) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('submission_queue', 'readwrite');
      const store = tx.objectStore('submission_queue');
      const request = store.get(submissionId);

      request.onsuccess = () => {
        if (request.result) {
          const submission = request.result;
          submission.status = status;
          submission.updated_at = new Date().toISOString();
          
          if (status === 'failed') {
            submission.retry_count = (submission.retry_count || 0) + 1;
            submission.last_retry = new Date().toISOString();
            submission.error = error;
          } else if (status === 'completed') {
            submission.completed_at = new Date().toISOString();
          }
          
          store.put(submission);
        }
      };

      tx.oncomplete = () => resolve();
      tx.onerror = (event) => reject(event.target.error);
    });
  }

  /**
   * Cleanup old cache
   */
  async cleanupOldCache() {
    return new Promise((resolve) => {
      // Check total cache size
      this.getCacheSize().then(size => {
        if (size > this.maxCacheSize) {
          console.log(`Cache size ${size} > ${this.maxCacheSize}, cleaning...`);
          this.deleteOldestCache();
        }
        resolve();
      }).catch(resolve);
    });
  }

  /**
   * Get total cache size
   */
  async getCacheSize() {
    return new Promise((resolve) => {
      let totalSize = 0;
      
      ['exam_packages', 'questions', 'images'].forEach(storeName => {
        const tx = this.db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const request = store.openCursor();
        
        request.onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor) {
            if (storeName === 'images' && cursor.value.size) {
              totalSize += cursor.value.size;
            } else {
              totalSize += JSON.stringify(cursor.value).length;
            }
            cursor.continue();
          }
        };
      });
      
      setTimeout(() => resolve(totalSize), 100);
    });
  }

  /**
   * Delete oldest cache items
   */
  async deleteOldestCache() {
    // Delete old images first
    const tx = this.db.transaction('images', 'readwrite');
    const store = tx.objectStore('images');
    const index = store.index('last_accessed');
    
    const request = index.openCursor();
    let deletedCount = 0;
    
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor && deletedCount < 10) { // Delete 10 oldest images
        cursor.delete();
        deletedCount++;
        cursor.continue();
      }
    };
  }

  /**
   * Update access times (internal)
   */
  async updatePackageAccessTime(agendaId) {
    const tx = this.db.transaction('exam_packages', 'readwrite');
    const store = tx.objectStore('exam_packages');
    const request = store.get(agendaId);
    
    request.onsuccess = () => {
      if (request.result) {
        request.result.last_accessed = Date.now();
        store.put(request.result);
      }
    };
  }

  async updateQuestionsAccessTime(agendaId, mapelId) {
    // Batch update untuk performa
    const answers = await this.getAllAnswers(agendaId, mapelId);
    const questionIds = Object.keys(answers);
    
    if (questionIds.length === 0) return;
    
    const tx = this.db.transaction('questions', 'readwrite');
    const store = tx.objectStore('questions');
    
    questionIds.forEach(questionId => {
      const request = store.get([agendaId, mapelId, questionId]);
      request.onsuccess = () => {
        if (request.result) {
          request.result.last_accessed = Date.now();
          store.put(request.result);
        }
      };
    });
  }

  async updateQuestionAccessTime(agendaId, mapelId, questionId) {
    const tx = this.db.transaction('questions', 'readwrite');
    const store = tx.objectStore('questions');
    const request = store.get([agendaId, mapelId, questionId]);
    
    request.onsuccess = () => {
      if (request.result) {
        request.result.last_accessed = Date.now();
        store.put(request.result);
      }
    };
  }

  async updateImageAccessTime(url) {
    const tx = this.db.transaction('images', 'readwrite');
    const store = tx.objectStore('images');
    const request = store.get(url);
    
    request.onsuccess = () => {
      if (request.result) {
        request.result.last_accessed = Date.now();
        store.put(request.result);
      }
    };
  }

  /**
   * Clear all cache (for testing/debugging)
   */
  async clearAllCache() {
    return new Promise((resolve) => {
      const request = indexedDB.deleteDatabase(this.dbName);
      
      request.onsuccess = () => {
        this.db = null;
        console.log('Cache cleared');
        resolve();
      };
      
      request.onerror = () => resolve();
    });
  }

  /**
   * Get cache statistics
   */
  async getStats() {
    return new Promise(async (resolve) => {
      const stats = {
        exam_packages: 0,
        questions: 0,
        temp_answers: 0,
        images: 0,
        submission_queue: 0,
        total_size: 0
      };
      
      // Count items in each store
      for (const storeName of ['exam_packages', 'questions', 'temp_answers', 'images', 'submission_queue']) {
        const tx = this.db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const request = store.count();
        
        request.onsuccess = () => {
          stats[storeName] = request.result;
        };
      }
      
      // Get total size
      stats.total_size = await this.getCacheSize();
      
      setTimeout(() => resolve(stats), 200);
    });
  }
}

// Export for browser
if (typeof window !== 'undefined') {
  window.ExamCacheManager = ExamCacheManager;
}
