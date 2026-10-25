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
  if (argc <= 1) {
    evict_root("/app/lean-project/.lake");
    evict_root("/opt/elan");
    evict_root("/app/node_modules");
    evict_root("/usr/local/lib/node_modules");
    return 0;
  }
  for (int i = 1; i < argc; i++) {
    evict_root(argv[i]);
  }
  return 0;
}
