// Tiny assert runner shared by the host DSP test binaries (no Catch2 /
// GoogleTest dependency). Include from exactly one .cpp per test executable:
// it defines main().
//
//   <binary> --list          # case names
//   <binary> onset band      # run cases whose name contains a filter
#pragma once

#include <cmath>
#include <cstdio>
#include <cstring>
#include <vector>

namespace host_test {

struct TestCase {
  const char* name;
  void (*fn)();
};

inline std::vector<TestCase>& registry() {
  static std::vector<TestCase> cases;
  return cases;
}

struct Registrar {
  Registrar(const char* name, void (*fn)()) { registry().push_back({name, fn}); }
};

inline int g_failures = 0;

inline void report(bool ok, const char* expr, const char* file, int line) {
  if (ok) return;
  ++g_failures;
  std::fprintf(stderr, "    %s:%d: CHECK(%s) failed\n", file, line, expr);
}

inline void report_cmp(bool ok, double a, double b, const char* expr, const char* file, int line) {
  if (ok) return;
  ++g_failures;
  std::fprintf(stderr, "    %s:%d: CHECK(%s) failed (%.9g vs %.9g)\n", file, line, expr, a, b);
}

}  // namespace host_test

#define TEST_CASE(name)                                                 \
  static void name();                                                   \
  static const host_test::Registrar registrar_##name(#name, name);      \
  static void name()

#define CHECK(cond) host_test::report((cond), #cond, __FILE__, __LINE__)
#define CHECK_LE(a, b) \
  host_test::report_cmp((a) <= (b), (a), (b), #a " <= " #b, __FILE__, __LINE__)
#define CHECK_GE(a, b) \
  host_test::report_cmp((a) >= (b), (a), (b), #a " >= " #b, __FILE__, __LINE__)
#define CHECK_NEAR(a, b, tol)                                                          \
  host_test::report_cmp(std::fabs((a) - (b)) <= (tol), (a), (b), #a " ~= " #b, __FILE__, \
                        __LINE__)

int main(int argc, char** argv) {
  using host_test::registry;
  if (argc > 1 && std::strcmp(argv[1], "--list") == 0) {
    for (const host_test::TestCase& t : registry()) std::printf("%s\n", t.name);
    return 0;
  }
  int ran = 0;
  int failed_cases = 0;
  for (const host_test::TestCase& t : registry()) {
    bool selected = argc <= 1;
    for (int i = 1; i < argc && !selected; ++i) selected = std::strstr(t.name, argv[i]) != nullptr;
    if (!selected) continue;
    ++ran;
    const int before = host_test::g_failures;
    std::printf("[ RUN  ] %s\n", t.name);
    t.fn();
    const bool ok = host_test::g_failures == before;
    if (!ok) ++failed_cases;
    std::printf("[ %s ] %s\n", ok ? " OK " : "FAIL", t.name);
  }
  std::printf("%d case(s), %d failed\n", ran, failed_cases);
  return ran == 0 || failed_cases > 0 ? 1 : 0;
}
