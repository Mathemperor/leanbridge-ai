#define _GNU_SOURCE
#include <dlfcn.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#ifndef MADV_PAGEOUT
#define MADV_PAGEOUT 21
#endif

#ifndef POSIX_FADV_DONTNEED
#define POSIX_FADV_DONTNEED 4
#endif

#define PM_FILE (1ULL << 61)
#define PM_PRESENT (1ULL << 63)
#define PM_CLEAN_FILE_MASK (PM_PRESENT | PM_FILE)

#define MEM_CURRENT_HIGH_BYTES (195LL * 1000 * 1000)
#define MEM_CURRENT_LOW_BYTES (135LL * 1000 * 1000)
#define MEM_FILE_HIGH_BYTES (80LL * 1000 * 1000)
#define MEM_FILE_LOW_BYTES (25LL * 1000 * 1000)
#define MEM_FILE_MIN_BYTES (8LL * 1000 * 1000)

#define MAX_VMAS 8192
#define PATH_POOL_SIZE (512 * 1024)
#define PAGEMAP_BATCH_PAGES 512
#define RECENT_MMAP_SLOTS 8

typedef struct {
  uintptr_t start;
  uintptr_t end;
  uint32_t path_offset;
  uint8_t is_readonly;
} vma_entry_t;

static int cgroup_current_fd = -1;
static int cgroup_stat_fd = -1;
static int pagemap_fd = -1;
static atomic_int guard_active = 0;
static __thread int in_memguard = 0;

static pthread_mutex_t evict_mutex = PTHREAD_MUTEX_INITIALIZER;
static atomic_size_t mapped_bytes_since_check = 0;
static atomic_size_t closed_files_since_check = 0;
static atomic_uint_fast64_t last_mmap_ns = 0;
static atomic_uintptr_t recent_mmap_addrs[RECENT_MMAP_SLOTS];
static atomic_size_t recent_mmap_cursor = 0;

static vma_entry_t vmas[MAX_VMAS];
static char path_pool[PATH_POOL_SIZE];
static uint64_t pagemap_buf[PAGEMAP_BATCH_PAGES];
static unsigned char mincore_buf[PAGEMAP_BATCH_PAGES];
static size_t sweep_cursor = 0;

typedef void *(*mmap_fn_t)(void *, size_t, int, int, int, off_t);
typedef int (*close_fn_t)(int);
typedef int (*fclose_fn_t)(FILE *);

static mmap_fn_t real_mmap_fn = NULL;
static close_fn_t real_close_fn = NULL;
static fclose_fn_t real_fclose_fn = NULL;

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

static int is_recently_mapped_vma(uintptr_t start) {
  for (size_t i = 0; i < RECENT_MMAP_SLOTS; i++) {
    if (atomic_load_explicit(&recent_mmap_addrs[i], memory_order_relaxed) == start) {
      return 1;
    }
  }
  return 0;
}

static long long read_cgroup_current(void) {
  if (cgroup_current_fd < 0) return -1;
  char buf[64];
  ssize_t n = pread(cgroup_current_fd, buf, sizeof(buf) - 1, 0);
  if (n <= 0) return -1;
  buf[n] = '\0';
  return strtoll(buf, NULL, 10);
}

static long long read_cgroup_file_bytes(void) {
  if (cgroup_stat_fd < 0) return -1;
  char buf[1024];
  ssize_t n = pread(cgroup_stat_fd, buf, sizeof(buf) - 1, 0);
  if (n <= 0) return -1;
  buf[n] = '\0';
  const char *p = strstr(buf, "\nfile ");
  if (p != NULL) {
    return strtoll(p + 6, NULL, 10);
  }
  if (strncmp(buf, "file ", 5) == 0) {
    return strtoll(buf + 5, NULL, 10);
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
  if (strncmp(path, "/app/lean-project/.lake/", 24) == 0) return 1;
  return 0;
}

static size_t load_lean_vmas(void) {
  FILE *fp = fopen("/proc/self/maps", "re");
  if (!fp) return 0;

  size_t count = 0;
  uint32_t pool_used = 0;
  char line[1024];

  while (fgets(line, sizeof(line), fp) != NULL && count < MAX_VMAS) {
    uintptr_t start = 0;
    uintptr_t end = 0;
    char perms[8] = {0};
    int path_pos = 0;

    if (sscanf(line, "%lx-%lx %4s %*x %*x:%*x %*u %n", &start, &end, perms, &path_pos) < 3) {
      continue;
    }
    if (path_pos <= 0 || end <= start || perms[0] != 'r' || perms[2] == 'x') {
      continue;
    }
    char *path = line + path_pos;
    while (*path == ' ' || *path == '\t') path++;
    size_t plen = strlen(path);
    while (plen > 0 && (path[plen - 1] == '\n' || path[plen - 1] == '\r')) {
      path[--plen] = '\0';
    }
    if (plen == 0 || path[0] != '/' || !is_target_lean_data_path(path)) {
      continue;
    }
    if (pool_used + plen + 1 > PATH_POOL_SIZE) {
      break;
    }

    uint32_t offset = pool_used;
    memcpy(path_pool + offset, path, plen + 1);
    pool_used += (uint32_t)(plen + 1);

    vmas[count].start = start;
    vmas[count].end = end;
    vmas[count].path_offset = offset;
    vmas[count].is_readonly = (perms[1] == '-') ? 1 : 0;
    count++;
  }

  if (real_fclose_fn) real_fclose_fn(fp);
  else fclose(fp);
  return count;
}

static size_t unmap_clean_file_pages(uintptr_t start, uintptr_t end, int is_readonly, int allow_rw_dontneed) {
  if (end <= start) return 0;

  size_t total_pages = (end - start) >> 12;
  size_t page_idx = 0;
  size_t resident_pages_found = 0;

  while (page_idx < total_pages) {
    size_t batch = total_pages - page_idx;
    if (batch > PAGEMAP_BATCH_PAGES) batch = PAGEMAP_BATCH_PAGES;

    uintptr_t batch_addr = start + (page_idx << 12);
    size_t batch_len = batch << 12;

    if (mincore((void *)batch_addr, batch_len, mincore_buf) == 0) {
      int any_resident = 0;
      for (size_t k = 0; k < batch; k++) {
        if (mincore_buf[k] & 1) {
          any_resident = 1;
          resident_pages_found++;
        }
      }
      if (!any_resident) {
        page_idx += batch;
        continue;
      }
    }

    madvise((void *)batch_addr, batch_len, MADV_PAGEOUT);

    if (is_readonly) {
      madvise((void *)batch_addr, batch_len, MADV_DONTNEED);
      resident_pages_found += batch;
      page_idx += batch;
      continue;
    }

    if (allow_rw_dontneed && pagemap_fd >= 0) {
      off_t pm_offset = (off_t)((batch_addr >> 12) * sizeof(uint64_t));
      ssize_t n = pread(pagemap_fd, pagemap_buf, batch * sizeof(uint64_t), pm_offset);
      if (n > 0) {
        size_t got = (size_t)n / sizeof(uint64_t);
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
          resident_pages_found += run_pages;
          void *span_addr = (void *)(batch_addr + (run_start << 12));
          size_t span_len = run_pages << 12;
          madvise(span_addr, span_len, MADV_DONTNEED);
        }
      }
    }

    page_idx += batch;
  }

  return resident_pages_found;
}

static void evict_dir_tree_fd(int dir_fd, int depth, int *files_evicted) {
  if (depth > 16) {
    raw_close(dir_fd);
    return;
  }
  DIR *dir = fdopendir(dir_fd);
  if (!dir) {
    raw_close(dir_fd);
    return;
  }
  struct dirent *entry;
  while ((entry = readdir(dir)) != NULL) {
    const char *name = entry->d_name;
    if (name[0] == '.' && (name[1] == '\0' || (name[1] == '.' && name[2] == '\0'))) {
      continue;
    }
    if (entry->d_type == DT_DIR) {
      int sub_fd = (int)syscall(SYS_openat, dir_fd, name, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW, 0);
      if (sub_fd >= 0) {
        evict_dir_tree_fd(sub_fd, depth + 1, files_evicted);
      }
    } else if (entry->d_type == DT_REG || entry->d_type == DT_UNKNOWN) {
      int fd = (int)syscall(SYS_openat, dir_fd, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW, 0);
      if (fd >= 0) {
        raw_fadvise_dontneed(fd);
        raw_close(fd);
        (*files_evicted)++;
      }
    }
  }
  closedir(dir);
}

static void evict_dir_path(const char *root_path) {
  int fd = raw_open_readonly(root_path, O_DIRECTORY);
  if (fd >= 0) {
    int count = 0;
    evict_dir_tree_fd(fd, 0, &count);
  }
}

static int needs_eviction(void) {
  long long cur = read_cgroup_current();
  long long file = read_cgroup_file_bytes();
  if (file >= MEM_FILE_HIGH_BYTES) return 1;
  if (cur >= MEM_CURRENT_HIGH_BYTES && (file < 0 || file >= MEM_FILE_MIN_BYTES)) return 1;
  return 0;
}

static int reached_low_target(void) {
  long long cur = read_cgroup_current();
  long long file = read_cgroup_file_bytes();
  if (file >= 0 && file <= MEM_FILE_MIN_BYTES) return 1;
  if (cur >= 0 && cur <= MEM_CURRENT_LOW_BYTES && (file < 0 || file <= MEM_FILE_LOW_BYTES)) return 1;
  return 0;
}

static void perform_eviction_locked(int force_all) {
  size_t count = load_lean_vmas();
  uint64_t now_ns = monotonic_ns();
  uint64_t last_map = atomic_load_explicit(&last_mmap_ns, memory_order_relaxed);
  int imports_settled = force_all || (now_ns > last_map && (now_ns - last_map) > 20000000ULL) ? 1 : 0;

  if (count > 0) {
    size_t idx = force_all ? 0 : (sweep_cursor % count);
    size_t visited = 0;
    size_t evicted_files = 0;

    while (visited < count) {
      const char *current_path = path_pool + vmas[idx].path_offset;
      size_t group_pages = 0;

      while (visited < count) {
        const vma_entry_t *v = &vmas[idx];
        const char *v_path = path_pool + v->path_offset;
        if (strcmp(v_path, current_path) != 0) {
          break;
        }
        if (force_all) {
          madvise((void *)v->start, v->end - v->start, MADV_DONTNEED);
          group_pages += (v->end - v->start) >> 12;
        } else {
          int allow_rw = imports_settled || !is_recently_mapped_vma(v->start);
          group_pages += unmap_clean_file_pages(v->start, v->end, v->is_readonly, allow_rw);
        }
        idx = (idx + 1) % count;
        visited++;
      }

      if (group_pages > 0) {
        int fd = raw_open_readonly(current_path, 0);
        if (fd >= 0) {
          raw_fadvise_dontneed(fd);
          raw_close(fd);
        }
        evicted_files++;
        if (!force_all && (evicted_files & 15) == 0 && reached_low_target()) {
          sweep_cursor = idx;
          return;
        }
      }
    }
    sweep_cursor = idx;
  }

  if (force_all || !reached_low_target()) {
    evict_dir_path("/app/lean-project/.lake");
    if (force_all) {
      evict_dir_path("/opt/elan");
    }
  }
}

static void maybe_evict(void) {
  if (!atomic_load_explicit(&guard_active, memory_order_relaxed) || in_memguard || !needs_eviction()) {
    return;
  }
  if (pthread_mutex_trylock(&evict_mutex) != 0) return;
  in_memguard = 1;
  if (needs_eviction()) {
    perform_eviction_locked(0);
  }
  in_memguard = 0;
  pthread_mutex_unlock(&evict_mutex);
}

static void *memguard_worker(void *arg) {
  (void)arg;
  struct timespec sleep_ts;
  sleep_ts.tv_sec = 0;
  sleep_ts.tv_nsec = 6 * 1000 * 1000; /* 6 ms */

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
    size_t slot = atomic_fetch_add_explicit(&recent_mmap_cursor, 1, memory_order_relaxed) & (RECENT_MMAP_SLOTS - 1);
    atomic_store_explicit(&recent_mmap_addrs[slot], (uintptr_t)ret, memory_order_relaxed);
    atomic_store_explicit(&last_mmap_ns, monotonic_ns(), memory_order_relaxed);
    size_t acc = atomic_fetch_add_explicit(&mapped_bytes_since_check, length, memory_order_relaxed) + length;
    if (acc >= (4 * 1024 * 1024)) {
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
      fd != cgroup_current_fd && fd != cgroup_stat_fd && fd != pagemap_fd) {
    int fl = fcntl(fd, F_GETFL);
    if (fl != -1 && (fl & O_ACCMODE) == O_RDONLY) {
      raw_fadvise_dontneed(fd);
      size_t cnt = atomic_fetch_add_explicit(&closed_files_since_check, 1, memory_order_relaxed) + 1;
      if ((cnt & 15) == 0) {
        maybe_evict();
      }
    }
  }
  return real_close_fn(fd);
}

int fclose(FILE *stream) {
  if (!real_fclose_fn) {
    real_fclose_fn = (fclose_fn_t)dlsym(RTLD_NEXT, "fclose");
  }
  if (atomic_load_explicit(&guard_active, memory_order_relaxed) &&
      !in_memguard && stream != NULL) {
    int fd = fileno(stream);
    if (fd >= 3 && fd != cgroup_current_fd && fd != cgroup_stat_fd && fd != pagemap_fd) {
      int fl = fcntl(fd, F_GETFL);
      if (fl != -1 && (fl & O_ACCMODE) == O_RDONLY) {
        raw_fadvise_dontneed(fd);
      }
    }
  }
  return real_fclose_fn(stream);
}

__attribute__((constructor))
static void memguard_init(void) {
  real_mmap_fn = (mmap_fn_t)dlsym(RTLD_NEXT, "mmap");
  real_close_fn = (close_fn_t)dlsym(RTLD_NEXT, "close");
  real_fclose_fn = (fclose_fn_t)dlsym(RTLD_NEXT, "fclose");

  if (!program_invocation_short_name || strcmp(program_invocation_short_name, "lean") != 0) {
    return;
  }
  cgroup_current_fd = raw_open_readonly("/sys/fs/cgroup/memory.current", 0);
  cgroup_stat_fd = raw_open_readonly("/sys/fs/cgroup/memory.stat", 0);
  pagemap_fd = raw_open_readonly("/proc/self/pagemap", 0);
  if (cgroup_current_fd < 0) {
    return;
  }
  atomic_store_explicit(&last_mmap_ns, monotonic_ns(), memory_order_relaxed);
  atomic_store_explicit(&guard_active, 1, memory_order_relaxed);

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
  if (!atomic_exchange_explicit(&guard_active, 0, memory_order_relaxed)) {
    return;
  }
  if (pthread_mutex_trylock(&evict_mutex) == 0) {
    in_memguard = 1;
    perform_eviction_locked(1);
    in_memguard = 0;
    pthread_mutex_unlock(&evict_mutex);
  }
}
