/**
 * IMAGE PRELOADER untuk CBTKU
 * Preload, cache, dan lazy load gambar soal
 */
class ImagePreloader {
  constructor(cacheManager) {
    this.cache = cacheManager;
    this.memoryCache = new Map();
    this.loadingQueue = new Map();
    this.pendingDownloads = new Set();
    this.maxConcurrentDownloads = 3;
    this.activeDownloads = 0;
    this.stats = {
      total_requested: 0,
      total_loaded: 0,
      total_failed: 0,
      total_cached: 0,
      cache_hits: 0,
      cache_misses: 0,
      memory_cache_size: 0
    };
  }

  /**
   * Preload multiple images
   */
  async preloadImages(imageUrls, priority = 'medium') {
    if (!imageUrls || imageUrls.length === 0) {
      return { success: true, preloaded: 0 };
    }

    console.log(`Preloading ${imageUrls.length} images with priority: ${priority}`);

    // Filter unique URLs
    const uniqueUrls = [...new Set(imageUrls.filter(url => 
      url && typeof url === 'string' && url.trim() !== ''
    ))];

    // Split into batches based on priority
    let highPriorityUrls = [];
    let mediumPriorityUrls = [];
    let lowPriorityUrls = [];

    if (priority === 'high') {
      // Untuk high priority, load semua sekaligus
      highPriorityUrls = uniqueUrls;
    } else if (priority === 'medium') {
      // Untuk medium priority, load 10 pertama sebagai high, sisanya medium
      highPriorityUrls = uniqueUrls.slice(0, Math.min(10, uniqueUrls.length));
      mediumPriorityUrls = uniqueUrls.slice(highPriorityUrls.length);
    } else {
      // Untuk low priority, load 5 pertama sebagai high, 10 berikutnya medium, sisanya low
      highPriorityUrls = uniqueUrls.slice(0, Math.min(5, uniqueUrls.length));
      mediumPriorityUrls = uniqueUrls.slice(
        highPriorityUrls.length, 
        highPriorityUrls.length + Math.min(10, uniqueUrls.length - highPriorityUrls.length)
      );
      lowPriorityUrls = uniqueUrls.slice(highPriorityUrls.length + mediumPriorityUrls.length);
    }

    this.stats.total_requested += uniqueUrls.length;

    // Load high priority images first (blocking)
    if (highPriorityUrls.length > 0) {
      console.log(`Loading ${highPriorityUrls.length} high priority images...`);
      await this.loadBatch(highPriorityUrls, 'high');
    }

    // Load medium priority in background
    if (mediumPriorityUrls.length > 0) {
      console.log(`Queueing ${mediumPriorityUrls.length} medium priority images...`);
      this.loadBatchBackground(mediumPriorityUrls, 'medium');
    }

    // Load low priority in background with delay
    if (lowPriorityUrls.length > 0) {
      console.log(`Queueing ${lowPriorityUrls.length} low priority images...`);
      setTimeout(() => {
        this.loadBatchBackground(lowPriorityUrls, 'low');
      }, 5000); // Delay 5 detik
    }

    return {
      success: true,
      requested: uniqueUrls.length,
      high_priority: highPriorityUrls.length,
      medium_priority: mediumPriorityUrls.length,
      low_priority: lowPriorityUrls.length,
      stats: { ...this.stats }
    };
  }

  /**
   * Load batch of images (blocking)
   */
  async loadBatch(urls, priority = 'medium') {
    const results = await Promise.allSettled(
      urls.map(url => this.loadImage(url, priority))
    );

    const successful = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    console.log(`Batch load complete: ${successful} success, ${failed} failed`);

    return {
      total: urls.length,
      successful,
      failed,
      results: results.map((r, i) => ({
        url: urls[i],
        status: r.status,
        value: r.status === 'fulfilled' ? r.value : null,
        reason: r.status === 'rejected' ? r.reason?.message : null
      }))
    };
  }

  /**
   * Load batch in background
   */
  loadBatchBackground(urls, priority = 'low') {
    urls.forEach(url => {
      this.addToQueue(url, priority);
    });
    this.processQueue();
  }

  /**
   * Load single image dengan caching
   */
  async loadImage(url, priority = 'medium') {
    // 1. Cek memory cache (paling cepat)
    if (this.memoryCache.has(url)) {
      this.stats.cache_hits++;
      return this.memoryCache.get(url);
    }

    // 2. Cek apakah sedang loading
    if (this.loadingQueue.has(url)) {
      return this.loadingQueue.get(url);
    }

    // 3. Cek IndexedDB cache
    const cachedImage = await this.cache.getCachedImage(url);
    if (cachedImage) {
      this.stats.cache_hits++;
      this.stats.total_cached++;
      
      // Simpan di memory cache
      this.memoryCache.set(url, cachedImage.url);
      this.stats.memory_cache_size = this.memoryCache.size;
      
      // Update last accessed
      this.updateImageAccessTime(url);
      
      return cachedImage.url;
    }

    this.stats.cache_misses++;

    // 4. Buat promise untuk download
    const loadPromise = this.downloadImage(url, priority);
    this.loadingQueue.set(url, loadPromise);

    try {
      const result = await loadPromise;
      
      // Simpan di memory cache
      this.memoryCache.set(url, result.objectUrl);
      this.stats.memory_cache_size = this.memoryCache.size;
      
      // Simpan di IndexedDB
      if (result.blob) {
        await this.cache.cacheImage(url, result.blob);
        this.stats.total_cached++;
      }
      
      this.stats.total_loaded++;
      this.loadingQueue.delete(url);
      
      return result.objectUrl;

    } catch (error) {
      this.stats.total_failed++;
      this.loadingQueue.delete(url);
      console.error(`Failed to load image ${url}:`, error);
      
      // Return original URL sebagai fallback
      return url;
    }
  }

  /**
   * Download image dari URL
   */
  async downloadImage(url, priority = 'medium') {
    return new Promise((resolve, reject) => {
      // Validasi URL
      if (!url || typeof url !== 'string') {
        reject(new Error('Invalid URL'));
        return;
      }

      // Buat timeout berdasarkan priority
      const timeout = priority === 'high' ? 15000 : // 15 detik untuk high
                     priority === 'medium' ? 10000 : // 10 detik untuk medium
                     5000; // 5 detik untuk low

      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.responseType = 'blob';
      xhr.timeout = timeout;

      // Set headers untuk cache control
      xhr.setRequestHeader('Cache-Control', 'max-age=86400'); // 24 jam
      xhr.setRequestHeader('Pragma', 'cache');

      // Setup event handlers
      const timer = setTimeout(() => {
        xhr.abort();
        reject(new Error(`Timeout setelah ${timeout}ms`));
      }, timeout);

      xhr.onload = () => {
        clearTimeout(timer);
        
        if (xhr.status === 200) {
          const blob = xhr.response;
          const objectUrl = URL.createObjectURL(blob);
          
          resolve({
            url: url,
            blob: blob,
            objectUrl: objectUrl,
            size: blob.size,
            type: blob.type,
            loaded_from: 'network'
          });
        } else {
          reject(new Error(`HTTP ${xhr.status}: ${xhr.statusText}`));
        }
      };

      xhr.onerror = () => {
        clearTimeout(timer);
        reject(new Error('Network error'));
      };

      xhr.ontimeout = () => {
        reject(new Error('Request timeout'));
      };

      xhr.send();
    });
  }

  /**
   * Get image (dengan fallback ke placeholder)
   */
  async getImage(url, placeholder = null) {
    try {
      if (!url || url.trim() === '') {
        return placeholder || '/placeholder.png';
      }

      // Coba load dengan retry
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const imageUrl = await this.loadImage(url, 'medium');
          return imageUrl;
        } catch (error) {
          if (attempt === 2) {
            // Last attempt failed, return original URL
            console.warn(`Failed to load image after ${attempt} attempts: ${url}`);
            return url;
          }
          // Wait before retry
          await this.sleep(1000 * attempt);
        }
      }

      return url;
    } catch (error) {
      console.error('Get image error:', error);
      return url; // Fallback ke URL asli
    }
  }

  /**
   * Lazy load image untuk element
   */
  lazyLoadImage(imgElement, placeholder = null) {
    const url = imgElement.dataset.src || imgElement.src;
    
    if (!url) {
      return;
    }

    // Set placeholder terlebih dahulu
    if (placeholder && (!imgElement.src || imgElement.src === '')) {
      imgElement.src = placeholder;
    }

    // Cek apakah image sudah dalam viewport
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const img = entry.target;
          
          // Load image
          this.getImage(url).then(imageUrl => {
            if (imageUrl && imageUrl !== img.src) {
              img.src = imageUrl;
              img.classList.add('loaded');
              
              // Dispatch event untuk animasi
              img.dispatchEvent(new Event('load'));
            }
          }).catch(() => {
            // Tetap gunakan URL asli jika gagal
            img.src = url;
          });
          
          observer.unobserve(img);
        }
      });
    }, {
      rootMargin: '50px', // Load 50px sebelum masuk viewport
      threshold: 0.1
    });

    observer.observe(imgElement);
  }

  /**
   * Preload images untuk soal tertentu
   */
  async preloadForQuestions(questions) {
    if (!questions || !Array.isArray(questions)) {
      return;
    }

    // Extract image URLs dari questions
    const imageUrls = questions
      .map(q => q.gambar_url)
      .filter(url => url && url.trim() !== '');
    
    // Juga extract dari pilihan jika ada gambar
    questions.forEach(q => {
      ['a', 'b', 'c', 'd', 'e'].forEach(opt => {
        const gambarKey = `gambar_${opt}`;
        if (q[gambarKey]) {
          imageUrls.push(q[gambarKey]);
        }
      });
    });

    if (imageUrls.length === 0) {
      return;
    }

    // Preload dengan priority medium
    return this.preloadImages([...new Set(imageUrls)], 'medium');
  }

  /**
   * Clear memory cache
   */
  clearMemoryCache() {
    // Revoke semua object URLs
    this.memoryCache.forEach(url => {
      if (url.startsWith('blob:')) {
        URL.revokeObjectURL(url);
      }
    });
    
    this.memoryCache.clear();
    this.stats.memory_cache_size = 0;
    
    console.log('Memory cache cleared');
  }

  /**
   * Get loading status
   */
  getLoadingStatus() {
    return {
      active_downloads: this.activeDownloads,
      queue_size: this.pendingDownloads.size,
      loading_queue: this.loadingQueue.size,
      memory_cache: this.memoryCache.size,
      stats: { ...this.stats }
    };
  }

  /**
   * Queue management
   */
  addToQueue(url, priority = 'low') {
    if (!this.pendingDownloads.has(url)) {
      this.pendingDownloads.add({
        url,
        priority,
        added: Date.now()
      });
    }
  }

  async processQueue() {
    if (this.activeDownloads >= this.maxConcurrentDownloads || this.pendingDownloads.size === 0) {
      return;
    }

    // Sort by priority and time added
    const sorted = Array.from(this.pendingDownloads)
      .sort((a, b) => {
        const priorityOrder = { high: 0, medium: 1, low: 2 };
        if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
          return priorityOrder[a.priority] - priorityOrder[b.priority];
        }
        return a.added - b.added;
      });

    while (this.activeDownloads < this.maxConcurrentDownloads && sorted.length > 0) {
      const item = sorted.shift();
      this.pendingDownloads.delete(item);
      
      this.activeDownloads++;
      
      this.downloadImage(item.url, item.priority)
        .then(async (result) => {
          // Cache the image
          if (result.blob) {
            await this.cache.cacheImage(item.url, result.blob);
          }
        })
        .catch(() => {
          // Ignore errors for background downloads
        })
        .finally(() => {
          this.activeDownloads--;
          this.processQueue();
        });
    }
  }

  /**
   * Update image access time di cache
   */
  async updateImageAccessTime(url) {
    // Update di IndexedDB via cache manager
    // (Cache manager sudah handle ini)
  }

  /**
   * Helper: sleep function
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Health check
   */
  async healthCheck() {
    return {
      status: 'operational',
      memory_cache_size: this.memoryCache.size,
      loading_queue: this.loadingQueue.size,
      pending_downloads: this.pendingDownloads.size,
      active_downloads: this.activeDownloads,
      stats: { ...this.stats },
      capabilities: {
        lazy_loading: 'IntersectionObserver' in window,
        service_worker: 'serviceWorker' in navigator,
        indexed_db: 'indexedDB' in window
      }
    };
  }
}

// Export for browser
if (typeof window !== 'undefined') {
  window.ImagePreloader = ImagePreloader;
}
