/* Compile against the frozen 3.46.0 amalgamation, not the host SQLite. */
#include "sqlite3.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/wait.h>

static void sql(sqlite3 *db, const char *s) { assert(sqlite3_exec(db, s, 0, 0, 0) == SQLITE_OK); }
static sqlite3 *open_db(const char *file) {
  sqlite3 *db = 0; assert(sqlite3_open(file, &db) == SQLITE_OK);
  sqlite3_extended_result_codes(db, 1); sqlite3_busy_timeout(db, 0); return db;
}
static int scalar(sqlite3 *db, const char *s) {
  sqlite3_stmt *q = 0; assert(sqlite3_prepare_v2(db, s, -1, &q, 0) == SQLITE_OK);
  assert(sqlite3_step(q) == SQLITE_ROW); int n = sqlite3_column_int(q, 0); sqlite3_finalize(q); return n;
}
static void copy_file(const char *from, const char *to) {
  FILE *a = fopen(from, "rb"), *b = fopen(to, "wb"); assert(a && b);
  char buf[4096]; size_t n; while ((n = fread(buf, 1, sizeof(buf), a))) assert(fwrite(buf, 1, n, b) == n);
  assert(!ferror(a)); fclose(a); fclose(b);
}
int main(int argc, char **argv) {
  assert(strcmp(sqlite3_libversion(), "3.46.0") == 0);
  if (argc == 3 && strcmp(argv[1], "--writer") == 0) {
    sqlite3 *worker = open_db(argv[2]);
    int rc = sqlite3_exec(worker, "BEGIN IMMEDIATE", 0, 0, 0);
    sqlite3_close(worker); return rc == SQLITE_BUSY ? 0 : 1;
  }
  assert(argc == 2); char executable[4096]; assert(realpath(argv[0], executable));
  assert(chdir(argv[1]) == 0);
  sqlite3 *a = open_db("test.db"), *b;
  sql(a, "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t(x); INSERT INTO t VALUES(1);");
  b = open_db("test.db"); sql(b, "PRAGMA wal_autocheckpoint=0;");
  /* Parent holds the transaction throughout exec/wait: no timing guesses. */
  sql(a, "BEGIN IMMEDIATE;");
  pid_t pid = fork(); assert(pid >= 0);
  if (pid == 0) { execl(executable, executable, "--writer", "test.db", (char *)0); _exit(99); }
  int status; assert(waitpid(pid, &status, 0) == pid); assert(WIFEXITED(status) && WEXITSTATUS(status) == 0);
  sql(a, "ROLLBACK;");
  sql(a, "BEGIN;"); assert(scalar(a, "SELECT count(*) FROM t") == 1);
  sql(b, "INSERT INTO t VALUES(2);");
  assert(scalar(a, "SELECT count(*) FROM t") == 1);
  int snapshot = sqlite3_exec(a, "INSERT INTO t VALUES(3);", 0, 0, 0);
  assert(snapshot == SQLITE_BUSY_SNAPSHOT); sql(a, "ROLLBACK;");
  sql(a, "PRAGMA wal_checkpoint(TRUNCATE); BEGIN;"); assert(scalar(a, "SELECT count(*) FROM t") == 2);
  sql(b, "INSERT INTO t VALUES(4);");
  int log1, done1, log2, done2;
  assert(sqlite3_wal_checkpoint_v2(b, 0, SQLITE_CHECKPOINT_PASSIVE, &log1, &done1) == SQLITE_OK);
  assert(done1 < log1); sql(a, "ROLLBACK;");
  assert(sqlite3_wal_checkpoint_v2(b, 0, SQLITE_CHECKPOINT_TRUNCATE, &log2, &done2) == SQLITE_OK);
  assert(log2 == 0 && done2 == 0);
  sql(b, "INSERT INTO t VALUES(5);");
  copy_file("test.db", "copy.db");
  sqlite3 *copy = open_db("copy.db"), *backup = open_db("backup.db");
  int copyCount = scalar(copy, "SELECT count(*) FROM t");
  sqlite3_backup *task = sqlite3_backup_init(backup, "main", b, "main"); assert(task);
  assert(sqlite3_backup_step(task, -1) == SQLITE_DONE); assert(sqlite3_backup_finish(task) == SQLITE_OK);
  int actual = scalar(b, "SELECT count(*) FROM t"), backupCount = scalar(backup, "SELECT count(*) FROM t");
  assert(copyCount == 3 && actual == 4 && backupCount == actual);
  assert(scalar(backup, "SELECT count(*) FROM pragma_integrity_check WHERE integrity_check <> 'ok'") == 0);
  printf("{\"sqliteVersion\":\"%s\",\"sourceId\":\"%s\",\"journalMode\":\"wal\",\"synchronous\":2,\"busyTimeout\":0,\"walAutocheckpoint\":0,\"writerBusy\":5,\"snapshotBusy\":%d,\"checkpointBefore\":[%d,%d],\"checkpointAfter\":[%d,%d],\"mainFileCopyRows\":%d,\"backupRows\":%d,\"committedRows\":%d,\"passed\":4,\"compileOptions\":[", sqlite3_libversion(), sqlite3_sourceid(), snapshot, log1, done1, log2, done2, copyCount, backupCount, actual);
  for (int i=0; sqlite3_compileoption_get(i); ++i) printf("%s\"%s\"", i ? "," : "", sqlite3_compileoption_get(i));
  puts("]}");
  sqlite3_close(copy); sqlite3_close(backup); sqlite3_close(a); sqlite3_close(b);
  unlink("test.db"); unlink("test.db-wal"); unlink("test.db-shm"); unlink("copy.db"); unlink("backup.db");
  return 0;
}
