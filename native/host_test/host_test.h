// Tiny assert runner shared by the host DSP test binaries (no Catch2 /
// GoogleTest dependency). Include from exactly one .cpp per test executable:
// it defines main().
//
//   <binary> --list          # case names
//   <binary> onset band      # run cases whose name contains a filter
//   <binary> --fast          # skip LONG_TEST_CASEs (what PR CI runs)
//   <binary> --long          # only LONG_TEST_CASEs (the nightly battery)
//
// LONG_TEST_CASE marks a case that is slow under ASan + UBSan (seconds of
// audio through every stage); clip_stacker_host_test registers the binary
// twice, `<name>` (--fast, CTest label `pr`) and `<name>_long` (--long, label
// `nightly`), so `ctest -L pr` stays quick and the full battery still runs.
#pragma once

#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <vector>

namespace host_test {

struct TestCase {
  const char* name;
  void (*fn)();
  bool long_running;
};

inline std::vector<TestCase>& registry() {
  static std::vector<TestCase> cases;
  return cases;
}

struct Registrar {
  Registrar(const char* name, void (*fn)(), bool long_running = false) {
    registry().push_back({name, fn, long_running});
  }
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

#define LONG_TEST_CASE(name)                                                \
  static void name();                                                       \
  static const host_test::Registrar registrar_##name(#name, name, true);    \
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
  // --fast / --long pick by duration class; the remaining arguments filter by name.
  int mode = 0;  // 0 all, 1 fast only, 2 long only
  int filters = 0;
  for (int i = 1; i < argc; ++i) {
    if (std::strcmp(argv[i], "--fast") == 0) {
      mode = 1;
    } else if (std::strcmp(argv[i], "--long") == 0) {
      mode = 2;
    } else {
      ++filters;
    }
  }
  int ran = 0;
  int failed_cases = 0;
  for (const host_test::TestCase& t : registry()) {
    if ((mode == 1 && t.long_running) || (mode == 2 && !t.long_running)) continue;
    bool selected = filters == 0;
    for (int i = 1; i < argc && !selected; ++i) {
      if (argv[i][0] != '-') selected = std::strstr(t.name, argv[i]) != nullptr;
    }
    if (!selected) continue;
    ++ran;
    const int before = host_test::g_failures;
    std::printf("[ RUN  ] %s\n", t.name);
    const auto t0 = std::chrono::steady_clock::now();
    t.fn();
    const double seconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    const bool ok = host_test::g_failures == before;
    if (!ok) ++failed_cases;
    std::printf("[ %s ] %s (%.2f s)\n", ok ? " OK " : "FAIL", t.name, seconds);
  }
  std::printf("%d case(s), %d failed\n", ran, failed_cases);
  // A --long run of a binary with no long cases is not an error.
  if (ran == 0) return mode == 2 ? 0 : 1;
  return failed_cases > 0 ? 1 : 0;
}
