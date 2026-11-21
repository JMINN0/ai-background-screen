#define _GNU_SOURCE
#include <string.h>
#include <unistd.h>
#include <sys/types.h>
#include <pwd.h>
#include <stdlib.h>

/* adb 配对名 = <user>@<hostname>。
 * 我们跑在 proot 容器里，user=root、hostname=localhost，
 * 于是配对记录显示 `root@localhost` —— 既显眼又容易被误删。
 * 这里在 adb 进程内把两个值都改掉，不改系统、不影响别的程序。
 */

int gethostname(char *name, size_t len) {
    const char *fake = "dsh-go";
    if (len == 0) return -1;
    strncpy(name, fake, len - 1);
    name[len - 1] = '\0';
    return 0;
}

char *getlogin(void) { return (char *)"dsh"; }

/* getpwuid 有可重入版本，两个都拦 */
static struct passwd g_pw;
static char g_name[] = "dsh";
static char g_dir[] = "/root";
static char g_shell[] = "/bin/sh";

static void fill(struct passwd *p) {
    p->pw_name = g_name;
    p->pw_passwd = (char *)"x";
    p->pw_uid = 0;
    p->pw_gid = 0;
    p->pw_gecos = g_name;
    p->pw_dir = g_dir;
    p->pw_shell = g_shell;
}

struct passwd *getpwuid(uid_t uid) {
    if (uid == 0) { fill(&g_pw); return &g_pw; }
    return NULL;
}

int getpwuid_r(uid_t uid, struct passwd *pwd, char *buf, size_t buflen, struct passwd **result) {
    if (uid == 0) { fill(pwd); *result = pwd; return 0; }
    *result = NULL;
    return 0;
}
