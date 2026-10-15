// Host tests for the stabilizer: the C API end to end on small synthetic
// sequences, and the pure matrix / smoothing helpers (stab_math.h) on
// synthetic motion. Same source as public/wasm/video_stabilize.wasm, built
// natively under ASan + UBSan.

#include "video_stabilize.h"
#include "stab_math.h"
#include "host_test.h"

#include <cmath>
#include <cstdint>
#include <vector>

namespace {

constexpr int kW = 160;
constexpr int kH = 120;

/** Smooth, corner-rich texture sampled at a sub-pixel offset (camera pan). */
std::vector<uint8_t> texture(float offX, float offY) {
  std::vector<uint8_t> out(static_cast<size_t>(kW) * kH);
  for (int y = 0; y < kH; ++y) {
    for (int x = 0; x < kW; ++x) {
      const float u = static_cast<float>(x) + offX;
      const float v = static_cast<float>(y) + offY;
      const float val = 128.f + 50.f * std::sin(u * 0.21f) * std::cos(v * 0.17f) +
                        35.f * std::sin(u * 0.07f + v * 0.11f) +
                        25.f * std::cos(u * 0.13f - v * 0.23f);
      out[static_cast<size_t>(y) * kW + static_cast<size_t>(x)] =
          static_cast<uint8_t>(std::lround(std::fmin(255.f, std::fmax(0.f, val))));
    }
  }
  return out;
}

void matrix(const StabHandle* h, int i, float* m) { stab_get_matrix(h, i, m); }

bool isIdentity(const float* m, float tol) {
  return std::fabs(m[0] - 1.f) <= tol && std::fabs(m[1]) <= tol && std::fabs(m[2]) <= tol &&
         std::fabs(m[3]) <= tol && std::fabs(m[4] - 1.f) <= tol && std::fabs(m[5]) <= tol;
}

}  // namespace

TEST_CASE(create_rejects_invalid_size) {
  CHECK(stab_create(0, 10, 5) == nullptr);
  CHECK(stab_create(10, -1, 5) == nullptr);
  stab_destroy(nullptr);
}

TEST_CASE(matrix_before_finalize_is_identity) {
  StabHandle* h = stab_create(kW, kH, 5);
  float m[STAB_MATRIX_FLOATS] = {9, 9, 9, 9, 9, 9};
  matrix(h, 0, m);
  CHECK(isIdentity(m, 0.f));
  for (int i = 0; i < 4; ++i) stab_push_frame(h, texture(static_cast<float>(i) * 3.f, 0.f).data());
  matrix(h, 1, m);
  CHECK(isIdentity(m, 0.f));
  CHECK(stab_finalize(h) == CS_OK);
  CHECK(stab_push_frame(h, texture(0.f, 0.f).data()) == CS_ESTATE);  // two-phase
  matrix(h, 99, m);  // out of range
  CHECK(isIdentity(m, 0.f));
  stab_destroy(h);

  StabHandle* empty = stab_create(kW, kH, 5);
  CHECK(stab_finalize(empty) == CS_ESTATE);
  stab_destroy(empty);
}

TEST_CASE(bad_arguments_return_status) {
  CHECK(stab_create(0, kH, 5) == nullptr);
  CHECK(stab_create(kW, 8193, 5) == nullptr);
  CHECK(stab_push_frame(nullptr, texture(0.f, 0.f).data()) == CS_EINVAL);
  CHECK(stab_finalize(nullptr) == CS_EINVAL);
  StabHandle* h = stab_create(kW, kH, 5);
  CHECK(stab_push_frame(h, nullptr) == CS_EINVAL);
  CHECK(stab_frame_count(h) == 0);
  stab_destroy(h);
}

TEST_CASE(static_frames_yield_identity) {
  StabHandle* h = stab_create(kW, kH, 5);
  const std::vector<uint8_t> frame = texture(0.f, 0.f);
  for (int i = 0; i < 12; ++i) CHECK(stab_push_frame(h, frame.data()) == i);
  CHECK(stab_frame_count(h) == 12);
  CHECK(stab_finalize(h) == 0);
  float m[STAB_MATRIX_FLOATS];
  for (int i = 0; i < 12; ++i) {
    matrix(h, i, m);
    CHECK(isIdentity(m, 1e-5f));
  }
  CHECK_NEAR(stab_get_zoom(h), 1.f, 1e-5);
  CHECK_LE(stab_get_max_correction(h), 1e-5f);
  stab_destroy(h);
}

TEST_CASE(translated_frame_gives_opposite_sign_uv_shift) {
  // Still camera with one frame jolted: the content in frame 4 sits `jolt` px
  // right / down of where it is in every other frame (the camera moved
  // left / up). The motion tracker sees +shift going in and -shift coming out.
  const float joltX = 4.f;
  const float joltY = 3.f;
  const int frames = 9;
  const int jolted = 4;
  StabHandle* h = stab_create(kW, kH, 4);
  for (int i = 0; i < frames; ++i) {
    // texture(off) shows the world shifted by -off, so -jolt moves content +jolt.
    const float o = i == jolted ? 1.f : 0.f;
    stab_push_frame(h, texture(-joltX * o, -joltY * o).data());
  }
  CHECK(stab_finalize(h) == 0);

  float m[STAB_MATRIX_FLOATS];
  matrix(h, jolted, m);
  // Output pixel q must sample source q + jolt: tx/ty follow the content shift
  // in UV, i.e. opposite in sign to the camera's own move. Smoothing over the
  // 9-frame window leaves (1 - 1/9) of the jolt as correction.
  const float keep = 1.f - 1.f / static_cast<float>(frames);
  CHECK_NEAR(m[2], joltX * keep / kW, 0.15f / kW + 0.02f * joltX / kW);
  CHECK_NEAR(m[5], joltY * keep / kH, 0.15f / kH + 0.02f * joltY / kH);
  CHECK(m[2] > 0.f);
  CHECK(m[5] > 0.f);
  // No rotation snuck in, and the zoom crops at least the shift away.
  CHECK_NEAR(m[1], 0.f, 2e-3);
  CHECK_NEAR(m[3], 0.f, 2e-3);
  const float zoom = stab_get_zoom(h);
  CHECK_GE(zoom, 1.f + 2.f * m[2] - 1e-4f);
  CHECK_NEAR(m[0], 1.f / zoom, 5e-3);
  CHECK_NEAR(m[4], 1.f / zoom, 5e-3);

  // Neighbours are pulled the other way (towards the jolt's mean), far less.
  matrix(h, 0, m);
  CHECK(m[2] < 0.f);
  CHECK_LE(std::fabs(m[2]), joltX / kW * 0.25f);
  stab_destroy(h);
}

TEST_CASE(warp_before_finalize_copies) {
  StabHandle* h = stab_create(4, 4, 2);
  std::vector<uint8_t> in(4 * 4 * 4), out(in.size(), 0);
  for (size_t i = 0; i < in.size(); ++i) in[i] = static_cast<uint8_t>(i * 3);
  stab_apply_warp(h, in.data(), out.data(), 0);  // not finalized → identity
  CHECK(in == out);
  stab_destroy(h);
}

// --- stab_math.h -------------------------------------------------------------

TEST_CASE(smooth_series_is_centred_and_shrinks_at_ends) {
  std::vector<float> out;
  smoothSeries({0.f, 0.f, 9.f, 0.f, 0.f}, 1, &out);
  CHECK(out.size() == 5);
  CHECK_NEAR(out[0], 0.f, 1e-6);
  CHECK_NEAR(out[1], 3.f, 1e-6);
  CHECK_NEAR(out[2], 3.f, 1e-6);
  CHECK_NEAR(out[3], 3.f, 1e-6);
  CHECK_NEAR(out[4], 0.f, 1e-6);
  smoothSeries({2.f, 4.f}, 5, &out);  // window wider than the series
  CHECK_NEAR(out[0], 3.f, 1e-6);
  CHECK_NEAR(out[1], 3.f, 1e-6);
  smoothSeries({}, 3, &out);
  CHECK(out.empty());
}

TEST_CASE(fit_similarity_recovers_rotation_scale_translation) {
  const float theta = 0.1f;
  const float scale = 1.05f;
  const ComplexZ truth{scale * std::cos(theta), scale * std::sin(theta)};
  const Point t{3.f, -2.f};
  std::vector<Point> src, dst;
  std::vector<int> idx;
  for (int i = 0; i < 6; ++i) {
    const Point p{static_cast<float>(10 + 17 * i), static_cast<float>(50 - 9 * i * (i % 3))};
    Point q;
    applyZ(truth, t, p, &q);
    src.push_back(p);
    dst.push_back(q);
    idx.push_back(i);
  }
  ComplexZ z;
  Point tt;
  CHECK(fitSimilarity(src, dst, idx, &z, &tt));
  CHECK_NEAR(z.re, truth.re, 1e-4);
  CHECK_NEAR(z.im, truth.im, 1e-4);
  CHECK_NEAR(tt.x, t.x, 1e-2);
  CHECK_NEAR(tt.y, t.y, 1e-2);
  // Degenerate: one point, or all points coincident.
  CHECK(!fitSimilarity(src, dst, {0}, &z, &tt));
  CHECK(!fitSimilarity({src[0], src[0]}, {dst[0], dst[0]}, {0, 1}, &z, &tt));
}

TEST_CASE(corrections_for_still_camera_are_identity) {
  std::vector<Similarity> motion(10, Similarity{0.f, 0.f, 0.f, 0.f, true});
  float zoom = 0.f, maxOff = -1.f;
  const std::vector<Correction> c = buildCorrections(motion, 640, 360, 5, &zoom, &maxOff);
  CHECK(c.size() == 10);
  CHECK(zoom == 1.f);
  CHECK(maxOff == 0.f);
  for (const Correction& k : c) {
    CHECK(k.a == 1.f && k.b == 0.f && k.tx == 0.f && k.c == 0.f && k.d == 1.f && k.ty == 0.f);
  }
}

TEST_CASE(corrections_follow_trajectory_minus_smoothed) {
  // One +8 px x step at frame 3 of 7, radius large enough to average all.
  std::vector<Similarity> motion(7, Similarity{0.f, 0.f, 0.f, 0.f, true});
  motion[3].dx = 8.f;
  const int w = 400, h = 200;
  float zoom = 0.f, maxOff = 0.f;
  const std::vector<Correction> c = buildCorrections(motion, w, h, 10, &zoom, &maxOff);
  // Trajectory 0,0,0,8,8,8,8 → mean 32/7.
  const float mean = 32.f / 7.f;
  CHECK_NEAR(c[0].tx, (0.f - mean) / w, 1e-6);
  CHECK_NEAR(c[6].tx, (8.f - mean) / w, 1e-6);
  CHECK_NEAR(maxOff, mean / w, 1e-6);  // |0 - mean| > |8 - mean|
  CHECK_NEAR(zoom, 1.f + 2.f * maxOff, 1e-6);
  CHECK_NEAR(c[0].a, 1.f / zoom, 1e-6);
  for (const Correction& k : c) CHECK(k.ty == 0.f);

  // Invalid motion contributes nothing to the trajectory.
  motion[3].valid = false;
  const std::vector<Correction> none = buildCorrections(motion, w, h, 10, &zoom, &maxOff);
  for (const Correction& k : none) CHECK(k.tx == 0.f);
}

TEST_CASE(rotation_correction_is_aspect_scaled_and_zoom_capped) {
  std::vector<Similarity> motion(3, Similarity{0.f, 0.f, 0.f, 0.f, true});
  motion[1].dtheta = 0.03f;
  motion[2].dx = 400.f;  // huge shake → zoom hits the cap
  const int w = 320, h = 180;
  float zoom = 0.f, maxOff = 0.f;
  const std::vector<Correction> c = buildCorrections(motion, w, h, 1, &zoom, &maxOff);
  CHECK(zoom == kMaxZoom);
  const float aspect = static_cast<float>(w) / h;
  for (const Correction& k : c) {
    // b = -sin/aspect, c = sin*aspect (pre-zoom), so c = -b * aspect^2.
    CHECK_NEAR(k.c, -k.b * aspect * aspect, 1e-6);
    CHECK_NEAR(k.a, k.d, 1e-7);
  }
}
