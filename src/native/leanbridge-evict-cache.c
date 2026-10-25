#define _GNU_SOURCE
#include <dirent.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef POSIX_FADV_DONTNEED
#define POSIX_FADV_DONTNEED 4
#endif

#define TOUCHED_LOG_PATH "/tmp/leanbridge-touched-files.txt"

static void evict_single_file(const char *path) {
  if (!path || path[0] != '/') return;
  int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd >= 0) {
    posix_fadvise(fd, 0, 0, POSIX_FADV_DONTNEED);
    close(fd);
  }
}

static void evict_from_touched_log(void) {
  FILE *fp = fopen(TOUCHED_LOG_PATH, "re");
  if (!fp) return;

  char line[1024];
  while (fgets(line, sizeof(line), fp) != NULL) {
    size_t len = strlen(line);
    while (len > 0 && (line[len - 1] == '\n' || line[len - 1] == '\r')) {
      line[--len] = '\0';
    }
    if (len > 0) {
      evict_single_file(line);
    }
  }
  fclose(fp);
  unlink(TOUCHED_LOG_PATH);
}

static void walk_and_evict(int dir_fd, int depth) {
  if (depth > 20) {
    close(dir_fd);
    return;
  }
  DIR *dir = fdopendir(dir_fd);
  if (!dir) {
    close(dir_fd);
    return;
  }
  struct dirent *entry;
  while ((entry = readdir(dir)) != NULL) {
    const char *name = entry->d_name;
    if (name[0] == '.' && (name[1] == '\0' || (name[1] == '.' && name[2] == '\0'))) {
      continue;
    }
    if (entry->d_type == DT_DIR) {
      int sub_fd = openat(dir_fd, name, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
      if (sub_fd >= 0) {
        walk_and_evict(sub_fd, depth + 1);
      }
    } else if (entry->d_type == DT_REG || entry->d_type == DT_UNKNOWN) {
      int fd = openat(dir_fd, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
      if (fd >= 0) {
        posix_fadvise(fd, 0, 0, POSIX_FADV_DONTNEED);
        close(fd);
      }
    }
  }
  closedir(dir);
}

static void evict_root(const char *path) {
  int fd = open(path, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (fd >= 0) {
    walk_and_evict(fd, 0);
  }
}

int main(int argc, char **argv) {
  evict_from_touched_log();
  if (argc > 2 && strcmp(argv[1], "--walk") == 0) {
    for (int i = 2; i < argc; i++) {
      evict_root(argv[i]);
    }
  }
  return 0;
}
