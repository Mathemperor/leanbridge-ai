#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#ifndef POSIX_FADV_DONTNEED
#define POSIX_FADV_DONTNEED 4
#endif

#define PM_FILE (1ULL << 61)
#define PM_PRESENT (1ULL << 63)
#define PM_CLEAN_FILE_MASK (PM_PRESENT | PM_FILE)

#define MEM_CURRENT_HIGH_BYTES (350LL * 1000 * 1000)
#define MEM_CURRENT_EMERGENCY_BYTES (420LL * 1000 * 1000)
#define MEM_CURRENT_LOW_BYTES (275LL * 1000 * 1000)
#define MEM_FILE_HIGH_BYTES (220LL * 1000 * 1000)
#define MEM_FILE_LOW_BYTES (130LL * 1000 * 1000)
#define MEM_FILE_MIN_BYTES (95LL * 1000 * 1000)

#define NORMAL_MAX_SWEEP_BYTES (85ULL * 1000 * 1000)
#define EMERGENCY_MAX_SWEEP_BYTES (135ULL * 1000 * 1000)
#define SWEEP_COOLDOWN_NS (200ULL * 1000 * 1000)
#define EMERGENCY_COOLDOWN_NS (40ULL * 1000 * 1000)

#define MAX_UNIQUE_FILES 4096
#define PATH_HASH_SLOTS 8192
#define MAX_VMAS 8192
#define PATH_POOL_SIZE (512 * 1024)
#define PAGEMAP_BATCH_PAGES 512
#define MAPS_READ_BUF_SIZE 32768

#define TOUCHED_LOG_PATH "/tmp/leanbridge-touched-files.txt"

typedef struct {
  uint32_t path_offset;
  int32_t first_vma_idx;
} unique_file_t;

typedef struct {
  uintptr_t start;
  uintptr_t end;
  int32_t next_vma_idx;
} vma_entry_t;

static int cgroup_current_fd = -1;
static int cgroup_stat_fd = -1;
static int pagemap_fd = -1;
static int touched_log_fd = -1;
static atomic_int guard_active = 0;
static __thread int in_memguard = 0;

static pthread_mutex_t evict_mutex = PTHREAD_MUTEX_INITIALIZER;
static atomic_size_t mapped_bytes_since_check = 0;
static atomic_uint_fast64_t last_evict_ns = 0;

static unique_file_t unique_files[MAX_UNIQUE_FILES];
static size_t unique_file_count = 0;
static int32_t path_hash_table[PATH_HASH_SLOTS]; /* 0 = empty, else file_idx + 1 */
static char path_pool[PATH_POOL_SIZE];
static uint32_t path_pool_used = 0;

static vma_entry_t vmas[MAX_VMAS];
static size_t vma_count = 0;
static size_t fifo_file_cursor = 0;

static uint64_t pagemap_buf[PAGEMAP_BATCH_PAGES];
static char maps_read_buf[MAPS_READ_BUF_SIZE];

typedef void *(*mmap_fn_t)(void *, size_t, int, int, int, off_t);
typedef int (*close_fn_t)(int);

static mmap_fn_t real_mmap_fn = NULL;
static close_fn_t real_close_fn = NULL;

static int raw_open_readonly(const char *path, int extra_flags) {
  return (int)syscall(SYS_openat, AT_FDCWD, path, O_RDONLY | O_CLOEXEC | extra_flags, 0);
}

static void raw_close(int fd) {
  if (fd >= 0) {
    syscall(SYS_close, fd);
  }
}

static void raw_fadvise_dontneed(int fd) {
  if (fd >= 0) {
    syscall(SYS_fadvise64, fd, (off_t)0, (off_t)0, POSIX_FADV_DONTNEED);
  }
}

static uint64_t monotonic_ns(void) {
  struct timespec ts;
  if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) return 0;
  return (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
}

static long long parse_decimal(const char *s) {
  while (*s == ' ' || *s == '\t') s++;
  if (*s < '0' || *s > '9') return -1;
  long long val = 0;
  while (*s >= '0' && *s <= '9') {
    val = val * 10 + (*s - '0');
    s++;
  }
  return val;
}

static long long read_cgroup_current(void) {
  if (cgroup_current_fd < 0) return -1;
  char buf[64];
  ssize_t n = syscall(SYS_pread64, cgroup_current_fd, buf, sizeof(buf) - 1, (off_t)0);
  if (n <= 0) return -1;
  buf[n] = '\0';
  return parse_decimal(buf);
}

static long long read_cgroup_file_bytes(void) {
  if (cgroup_stat_fd < 0) return -1;
  char buf[1024];
  ssize_t n = syscall(SYS_pread64, cgroup_stat_fd, buf, sizeof(buf) - 1, (off_t)0);
  if (n <= 0) return -1;
  buf[n] = '\0';
  const char *p = strstr(buf, "\nfile ");
  if (p != NULL) {
    return parse_decimal(p + 6);
  }
  if (strncmp(buf, "file ", 5) == 0) {
    return parse_decimal(buf + 5);
  }
  return -1;
}

static int is_target_lean_data_path(const char *path) {
  if (strncmp(path, "/app/lean-project/", 18) != 0 &&
      strncmp(path, "/opt/elan/", 10) != 0) {
    return 0;
  }
  if (strstr(path, ".so") != NULL) {
    return 0;
  }
  size_t len = strlen(path);
  if (len >= 6 && strcmp(path + len - 6, ".olean") == 0) return 1;
  if (len >= 14 && strcmp(path + len - 14, ".olean.private") == 0) return 1;
  if (len >= 13 && strcmp(path + len - 13, ".olean.server") == 0) return 1;
  if (len >= 3 && strcmp(path + len - 3, ".ir") == 0) return 1;
  if (len >= 6 && strcmp(path + len - 6, ".ilean") == 0) return 1;
  return 0;
}

static int resolve_fd_path(int fd, char *buf, size_t buf_size) {
  if (fd < 0 || buf_size < 2) return 0;
  char link_path[40] = "/proc/self/fd/";
  char digits[16];
  int dlen = 0;
  unsigned int u = (unsigned int)fd;
  do {
    digits[dlen++] = (char)('0' + (u % 10));
    u /= 10;
  } while (u > 0 && dlen < (int)sizeof(digits));

  int pos = 14;
  while (dlen > 0) {
    link_path[pos++] = digits[--dlen];
  }
  link_path[pos] = '\0';

  ssize_t n = syscall(SYS_readlinkat, AT_FDCWD, link_path, buf, buf_size - 1);
  if (n <= 0) return 0;
  buf[n] = '\0';
  return 1;
}

static uint64_t hash_path_str(const char *s) {
  uint64_t h = 1469598103934665603ULL;
  while (*s) {
    h ^= (unsigned char)(*s++);
    h *= 1099511628211ULL;
  }
  return h;
}

static int32_t record_target_path_locked(const char *path) {
  if (!is_target_lean_data_path(path)) return -1;

  uint64_t h = hash_path_str(path);
  size_t mask = PATH_HASH_SLOTS - 1;

  for (size_t probe = 0; probe < PATH_HASH_SLOTS; probe++) {
    size_t slot = (size_t)((h + probe) & mask);
    int32_t entry = path_hash_table[slot];
    if (entry == 0) {
      if (unique_file_count >= MAX_UNIQUE_FILES) return -1;
      size_t plen = strlen(path);
      if (path_pool_used + plen + 2 > PATH_POOL_SIZE) return -1;

      uint32_t offset = path_pool_used;
      memcpy(path_pool + offset, path, plen);
      path_pool[offset + plen] = '\0';
      path_pool_used += (uint32_t)(plen + 1);

      int32_t fidx = (int32_t)unique_file_count++;
      unique_files[fidx].path_offset = offset;
      unique_files[fidx].first_vma_idx = -1;
      path_hash_table[slot] = fidx + 1;

      if (touched_log_fd >= 0) {
        char line_buf[1024];
        if (plen + 1 < sizeof(line_buf)) {
          memcpy(line_buf, path, plen);
          line_buf[plen] = '\n';
          syscall(SYS_write, touched_log_fd, line_buf, plen + 1);
        }
      }
      return fidx;
    }

    int32_t existing_idx = entry - 1;
    if (existing_idx >= 0 && (size_t)existing_idx < unique_file_count) {
      const char *existing_path = path_pool + unique_files[existing_idx].path_offset;
      if (strcmp(existing_path, path) == 0) {
        return existing_idx;
      }
    }
  }
  return -1;
}

static int parse_hex_uintptr(const char **p, uintptr_t *out) {
  const char *s = *p;
  uintptr_t val = 0;
  int digits = 0;
  while (*s) {
    char c = *s;
    uintptr_t v;
    if (c >= '0' && c <= '9') v = (uintptr_t)(c - '0');
    else if (c >= 'a' && c <= 'f') v = (uintptr_t)(c - 'a' + 10);
    else if (c >= 'A' && c <= 'F') v = (uintptr_t)(c - 'A' + 10);
    else break;
    val = (val << 4) | v;
    s++;
    digits++;
  }
  *p = s;
  *out = val;
  return digits > 0;
}

static void parse_maps_line_locked(char *line) {
  const char *p = line;
  uintptr_t start = 0;
  uintptr_t end = 0;

  if (!parse_hex_uintptr(&p, &start) || *p != '-') return;
  p++;
  if (!parse_hex_uintptr(&p, &end) || *p != ' ') return;
  p++;
  if (end <= start) return;

  char r_perm = p[0];
  char x_perm = (p[0] && p[1] && p[2]) ? p[2] : '\0';
  if (r_perm != 'r' || x_perm == 'x') return;

  const char *slash = strchr(p, '/');
  if (!slash) return;

  size_t plen = strlen(slash);
  while (plen > 0 && (slash[plen - 1] == '\n' || slash[plen - 1] == '\r')) {
    plen--;
  }
  if (plen == 0 || plen >= 1024) return;

  char path_buf[1024];
  memcpy(path_buf, slash, plen);
  path_buf[plen] = '\0';

  int32_t fidx = record_target_path_locked(path_buf);
  if (fidx < 0 || vma_count >= MAX_VMAS) return;

  int32_t vidx = (int32_t)vma_count++;
  vmas[vidx].start = start;
  vmas[vidx].end = end;
  vmas[vidx].next_vma_idx = unique_files[fidx].first_vma_idx;
  unique_files[fidx].first_vma_idx = vidx;
}

static void load_lean_vmas_locked(void) {
  for (size_t i = 0; i < unique_file_count; i++) {
    unique_files[i].first_vma_idx = -1;
  }
  vma_count = 0;

  int fd = raw_open_readonly("/proc/self/maps", 0);
  if (fd < 0) return;

  size_t leftover = 0;
  for (;;) {
    ssize_t n = syscall(SYS_read, fd, maps_read_buf + leftover, MAPS_READ_BUF_SIZE - 1 - leftover);
    if (n <= 0) break;
    size_t total = leftover + (size_t)n;
    maps_read_buf[total] = '\0';

    char *line_start = maps_read_buf;
    for (;;) {
      char *nl = memchr(line_start, '\n', (size_t)(maps_read_buf + total - line_start));
      if (!nl) break;
      *nl = '\0';
      parse_maps_line_locked(line_start);
      line_start = nl + 1;
    }

    leftover = (size_t)(maps_read_buf + total - line_start);
    if (leftover > 0) {
      if (leftover >= MAPS_READ_BUF_SIZE - 1) {
        leftover = 0;
      } else {
        memmove(maps_read_buf, line_start, leftover);
      }
    }
  }

  raw_close(fd);
}

static size_t unmap_clean_file_pages(uintptr_t start, uintptr_t end) {
  if (end <= start || pagemap_fd < 0) return 0;

  size_t total_pages = (end - start) >> 12;
  size_t page_idx = 0;
  size_t resident_clean_pages = 0;

  while (page_idx < total_pages) {
    size_t batch = total_pages - page_idx;
    if (batch > PAGEMAP_BATCH_PAGES) batch = PAGEMAP_BATCH_PAGES;

    uintptr_t batch_addr = start + (page_idx << 12);
    off_t pm_offset = (off_t)((batch_addr >> 12) * sizeof(uint64_t));
    ssize_t n = syscall(SYS_pread64, pagemap_fd, pagemap_buf, batch * sizeof(uint64_t), pm_offset);
    if (n <= 0) {
      break;
    }

    size_t got = (size_t)n / sizeof(uint64_t);
    if (got == 0) break;

    size_t i = 0;
    while (i < got) {
      if ((pagemap_buf[i] & PM_CLEAN_FILE_MASK) != PM_CLEAN_FILE_MASK) {
        i++;
        continue;
      }
      size_t run_start = i;
      while (i < got && (pagemap_buf[i] & PM_CLEAN_FILE_MASK) == PM_CLEAN_FILE_MASK) {
        i++;
      }
      size_t run_pages = i - run_start;
      resident_clean_pages += run_pages;
      void *span_addr = (void *)(batch_addr + (run_start << 12));
      size_t span_len = run_pages << 12;
      madvise(span_addr, span_len, MADV_DONTNEED);
    }

    page_idx += got;
  }

  return resident_clean_pages;
}

static int needs_eviction(void) {
  long long cur = read_cgroup_current();
  long long file = read_cgroup_file_bytes();
  if (file >= 0 && file < MEM_FILE_MIN_BYTES) {
    return 0;
  }

  uint64_t now = monotonic_ns();
  uint64_t last = atomic_load_explicit(&last_evict_ns, memory_order_relaxed);
  uint64_t elapsed = (now > last) ? (now - last) : 0;

  if (cur >= MEM_CURRENT_EMERGENCY_BYTES && elapsed >= EMERGENCY_COOLDOWN_NS) {
    return 2;
  }
  if (elapsed < SWEEP_COOLDOWN_NS) {
    return 0;
  }
  if (cur >= MEM_CURRENT_HIGH_BYTES || file >= MEM_FILE_HIGH_BYTES) {
    return 1;
  }
  return 0;
}

static int reached_low_target(void) {
  long long cur = read_cgroup_current();
  long long file = read_cgroup_file_bytes();
  if (file >= 0 && file <= MEM_FILE_LOW_BYTES) return 1;
  if (cur >= 0 && cur <= MEM_CURRENT_LOW_BYTES) return 1;
  return 0;
}

static void perform_eviction_locked(int mode) {
  load_lean_vmas_locked();

  if (mode == 3) {
    /* Process exit: unmap and evict all recorded target files */
    for (size_t i = 0; i < vma_count; i++) {
      if (vmas[i].end > vmas[i].start) {
        madvise((void *)vmas[i].start, vmas[i].end - vmas[i].start, MADV_DONTNEED);
      }
    }
    for (size_t fidx = 0; fidx < unique_file_count; fidx++) {
      const char *fpath = path_pool + unique_files[fidx].path_offset;
      int fd = raw_open_readonly(fpath, 0);
      if (fd >= 0) {
        raw_fadvise_dontneed(fd);
        raw_close(fd);
      }
    }
    return;
  }

  size_t protect_tail = (mode == 2) ? 32 : 128;
  uint64_t max_sweep_bytes = (mode == 2) ? EMERGENCY_MAX_SWEEP_BYTES : NORMAL_MAX_SWEEP_BYTES;

  if (unique_file_count <= protect_tail) {
    atomic_store_explicit(&last_evict_ns, monotonic_ns(), memory_order_relaxed);
    return;
  }

  size_t evictable_limit = unique_file_count - protect_tail;
  size_t start_cursor = fifo_file_cursor % evictable_limit;
  uint64_t evicted_bytes = 0;
  size_t evicted_files = 0;

  for (size_t visited = 0; visited < evictable_limit; visited++) {
    size_t fidx = (start_cursor + visited) % evictable_limit;
    int32_t vidx = unique_files[fidx].first_vma_idx;
    if (vidx < 0) continue;

    size_t file_pages = 0;
    while (vidx >= 0) {
      file_pages += unmap_clean_file_pages(vmas[vidx].start, vmas[vidx].end);
      vidx = vmas[vidx].next_vma_idx;
    }

    if (file_pages > 0) {
      const char *fpath = path_pool + unique_files[fidx].path_offset;
      int fd = raw_open_readonly(fpath, 0);
      if (fd >= 0) {
        raw_fadvise_dontneed(fd);
        raw_close(fd);
      }
      evicted_bytes += (uint64_t)file_pages << 12;
      evicted_files++;

      if (evicted_bytes >= max_sweep_bytes || ((evicted_files & 7) == 0 && reached_low_target())) {
        fifo_file_cursor = (fidx + 1) % evictable_limit;
        atomic_store_explicit(&last_evict_ns, monotonic_ns(), memory_order_relaxed);
        return;
      }
    }
  }

  fifo_file_cursor = 0;
  atomic_store_explicit(&last_evict_ns, monotonic_ns(), memory_order_relaxed);
}

static void maybe_evict(void) {
  if (!atomic_load_explicit(&guard_active, memory_order_relaxed) || in_memguard) {
    return;
  }
  int mode = needs_eviction();
  if (!mode) return;
  if (pthread_mutex_trylock(&evict_mutex) != 0) return;
  in_memguard = 1;
  mode = needs_eviction();
  if (mode) {
    perform_eviction_locked(mode);
  }
  in_memguard = 0;
  pthread_mutex_unlock(&evict_mutex);
}

static void *memguard_worker(void *arg) {
  (void)arg;
  struct timespec sleep_ts;
  sleep_ts.tv_sec = 0;
  sleep_ts.tv_nsec = 25 * 1000 * 1000; /* 25 ms */

  while (atomic_load_explicit(&guard_active, memory_order_relaxed)) {
    nanosleep(&sleep_ts, NULL);
    maybe_evict();
  }
  return NULL;
}

void *mmap(void *addr, size_t length, int prot, int flags, int fd, off_t offset) {
  if (!real_mmap_fn) {
    real_mmap_fn = (mmap_fn_t)dlsym(RTLD_NEXT, "mmap");
  }
  void *ret = real_mmap_fn(addr, length, prot, flags, fd, offset);
  if (atomic_load_explicit(&guard_active, memory_order_relaxed) &&
      !in_memguard && ret != MAP_FAILED && fd >= 0 && length >= 4096) {
    in_memguard = 1;
    char path_buf[1024];
    if (resolve_fd_path(fd, path_buf, sizeof(path_buf)) && is_target_lean_data_path(path_buf)) {
      if (pthread_mutex_trylock(&evict_mutex) == 0) {
        record_target_path_locked(path_buf);
        pthread_mutex_unlock(&evict_mutex);
      }
    }
    in_memguard = 0;

    size_t acc = atomic_fetch_add_explicit(&mapped_bytes_since_check, length, memory_order_relaxed) + length;
    if (acc >= (8 * 1024 * 1024)) {
      atomic_store_explicit(&mapped_bytes_since_check, 0, memory_order_relaxed);
      maybe_evict();
    }
  }
  return ret;
}

void *mmap64(void *addr, size_t length, int prot, int flags, int fd, off_t offset) {
  return mmap(addr, length, prot, flags, fd, offset);
}

int close(int fd) {
  if (!real_close_fn) {
    real_close_fn = (close_fn_t)dlsym(RTLD_NEXT, "close");
  }
  if (atomic_load_explicit(&guard_active, memory_order_relaxed) &&
      !in_memguard && fd >= 3 &&
      fd != cgroup_current_fd && fd != cgroup_stat_fd &&
      fd != pagemap_fd && fd != touched_log_fd) {
    in_memguard = 1;
    char path_buf[1024];
    if (resolve_fd_path(fd, path_buf, sizeof(path_buf)) && is_target_lean_data_path(path_buf)) {
      raw_fadvise_dontneed(fd);
      if (pthread_mutex_trylock(&evict_mutex) == 0) {
        record_target_path_locked(path_buf);
        pthread_mutex_unlock(&evict_mutex);
      }
    }
    in_memguard = 0;
  }
  return real_close_fn(fd);
}

static void memguard_cleanup_on_exit(void) {
  if (!atomic_exchange_explicit(&guard_active, 0, memory_order_acq_rel)) {
    return;
  }
  pthread_mutex_lock(&evict_mutex);
  in_memguard = 1;
  perform_eviction_locked(3);
  raw_close(touched_log_fd);
  touched_log_fd = -1;
  raw_close(pagemap_fd);
  pagemap_fd = -1;
  raw_close(cgroup_current_fd);
  cgroup_current_fd = -1;
  raw_close(cgroup_stat_fd);
  cgroup_stat_fd = -1;
  in_memguard = 0;
  pthread_mutex_unlock(&evict_mutex);
}

void _exit(int status) {
  memguard_cleanup_on_exit();
  syscall(SYS_exit_group, status);
  for (;;) {
    syscall(SYS_exit, status);
  }
}

void _Exit(int status) {
  _exit(status);
}

__attribute__((constructor))
static void memguard_init(void) {
  real_mmap_fn = (mmap_fn_t)dlsym(RTLD_NEXT, "mmap");
  real_close_fn = (close_fn_t)dlsym(RTLD_NEXT, "close");

  if (!program_invocation_short_name || strcmp(program_invocation_short_name, "lean") != 0) {
    return;
  }
  cgroup_current_fd = raw_open_readonly("/sys/fs/cgroup/memory.current", 0);
  cgroup_stat_fd = raw_open_readonly("/sys/fs/cgroup/memory.stat", 0);
  pagemap_fd = raw_open_readonly("/proc/self/pagemap", 0);
  touched_log_fd = (int)syscall(
      SYS_openat,
      AT_FDCWD,
      TOUCHED_LOG_PATH,
      O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC,
      0600);
  if (cgroup_current_fd < 0) {
    return;
  }
  atomic_store_explicit(&last_evict_ns, monotonic_ns(), memory_order_relaxed);
  atomic_store_explicit(&guard_active, 1, memory_order_release);

  pthread_t tid;
  pthread_attr_t attr;
  if (pthread_attr_init(&attr) == 0) {
    pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
    pthread_attr_setstacksize(&attr, 64 * 1024);
    pthread_create(&tid, &attr, memguard_worker, NULL);
    pthread_attr_destroy(&attr);
  }
}

__attribute__((destructor))
static void memguard_fini(void) {
  memguard_cleanup_on_exit();
}
