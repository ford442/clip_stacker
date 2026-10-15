// Pure matrix / smoothing helpers for the stabilizer: the similarity fit, the
// trajectory smoother, and the motion -> normalized-UV correction step. No
// images, no optical flow, so host tests can drive them with synthetic motion
// instead of pushing full grayscale sequences (see tests/).
//
// Internal to video_stabilize; the C API in video_stabilize.h is what ships.
#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <vector>

namespace {

/** Cap on the auto-crop. Beyond this the picture softens more than the shake costs. */
constexpr float kMaxZoom = 1.25f;

struct Point {
  float x = 0.f;
  float y = 0.f;
};

/** Similarity transform about the frame centre: p' = z * p + t, z = s * e^(i*theta). */
struct Similarity {
  float dx = 0.f;
  float dy = 0.f;
  float dtheta = 0.f;
  /** log of the scale factor, so it accumulates additively like dx/dy/dtheta. */
  float dlogs = 0.f;
  bool valid = false;
};

float clampf(float v, float lo, float hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

struct ComplexZ {
  float re = 1.f;
  float im = 0.f;
};

/**
 * Closed-form least-squares similarity over all correspondences, solved in the
 * complex plane: minimising sum |q - (z*p + t)|^2 gives
 * z = sum((q - qbar) * conj(p - pbar)) / sum |p - pbar|^2.
 */
bool fitSimilarity(
    const std::vector<Point>& src,
    const std::vector<Point>& dst,
    const std::vector<int>& idx,
    ComplexZ* z,
    Point* t) {
  const size_t n = idx.size();
  if (n < 2) return false;

  float pbx = 0.f, pby = 0.f, qbx = 0.f, qby = 0.f;
  for (int i : idx) {
    pbx += src[static_cast<size_t>(i)].x;
    pby += src[static_cast<size_t>(i)].y;
    qbx += dst[static_cast<size_t>(i)].x;
    qby += dst[static_cast<size_t>(i)].y;
  }
  const float inv = 1.f / static_cast<float>(n);
  pbx *= inv; pby *= inv; qbx *= inv; qby *= inv;

  float numRe = 0.f, numIm = 0.f, den = 0.f;
  for (int i : idx) {
    const float px = src[static_cast<size_t>(i)].x - pbx;
    const float py = src[static_cast<size_t>(i)].y - pby;
    const float qx = dst[static_cast<size_t>(i)].x - qbx;
    const float qy = dst[static_cast<size_t>(i)].y - qby;
    // (qx + i*qy) * conj(px + i*py)
    numRe += qx * px + qy * py;
    numIm += qy * px - qx * py;
    den += px * px + py * py;
  }
  if (den < 1e-6f) return false;

  z->re = numRe / den;
  z->im = numIm / den;
  t->x = qbx - (z->re * pbx - z->im * pby);
  t->y = qby - (z->im * pbx + z->re * pby);
  return true;
}

void applyZ(const ComplexZ& z, const Point& t, const Point& p, Point* out) {
  out->x = z.re * p.x - z.im * p.y + t.x;
  out->y = z.im * p.x + z.re * p.y + t.y;
}

struct Correction {
  float a = 1.f, b = 0.f, tx = 0.f;
  float c = 0.f, d = 1.f, ty = 0.f;
};

void identityMatrix(float* out) {
  out[0] = 1.f; out[1] = 0.f; out[2] = 0.f;
  out[3] = 0.f; out[4] = 1.f; out[5] = 0.f;
}

/** Centred moving average; the window shrinks at the ends rather than padding. */
void smoothSeries(const std::vector<float>& in, int radius, std::vector<float>* out) {
  const int n = static_cast<int>(in.size());
  out->assign(static_cast<size_t>(n), 0.f);
  if (n == 0) return;
  for (int i = 0; i < n; ++i) {
    const int lo = std::max(0, i - radius);
    const int hi = std::min(n - 1, i + radius);
    float sum = 0.f;
    for (int k = lo; k <= hi; ++k) sum += in[static_cast<size_t>(k)];
    (*out)[static_cast<size_t>(i)] = sum / static_cast<float>(hi - lo + 1);
  }
}

/**
 * Smooth the accumulated trajectory of `motion` and turn the gap between the
 * real and smoothed paths into per-frame inverse warps in normalized UV, with
 * the auto-crop zoom folded in. Writes the zoom and the peak |tx|/|ty|.
 */
std::vector<Correction> buildCorrections(
    const std::vector<Similarity>& motion,
    int width,
    int height,
    int smoothRadius,
    float* zoomOut,
    float* maxOffsetOut) {
  const size_t n = motion.size();
  // Trajectory: where a static world point has drifted to by frame i.
  std::vector<float> trajX(n, 0.f);
  std::vector<float> trajY(n, 0.f);
  std::vector<float> trajA(n, 0.f);
  std::vector<float> trajS(n, 0.f);
  float x = 0.f, y = 0.f, a = 0.f, s = 0.f;
  for (size_t i = 0; i < n; ++i) {
    const Similarity& m = motion[i];
    if (m.valid) {
      x += m.dx;
      y += m.dy;
      a += m.dtheta;
      s += m.dlogs;
    }
    trajX[i] = x;
    trajY[i] = y;
    trajA[i] = a;
    trajS[i] = s;
  }

  std::vector<float> smoothX, smoothY, smoothA, smoothS;
  smoothSeries(trajX, smoothRadius, &smoothX);
  smoothSeries(trajY, smoothRadius, &smoothY);
  smoothSeries(trajA, smoothRadius, &smoothA);
  smoothSeries(trajS, smoothRadius, &smoothS);

  const float w = static_cast<float>(width);
  const float hgt = static_cast<float>(height);
  const float aspect = hgt > 0.f ? w / hgt : 1.f;

  // Correction = how far the real trajectory ran ahead of the smoothed one.
  // Output pixel q must show the source pixel the point actually sits at, so
  // the lookup offset is (trajectory - smoothed).
  std::vector<Correction> raw(n);
  float maxOffset = 0.f;
  for (size_t i = 0; i < n; ++i) {
    const float corrX = trajX[i] - smoothX[i];
    const float corrY = trajY[i] - smoothY[i];
    const float corrA = trajA[i] - smoothA[i];
    const float corrS = std::exp(trajS[i] - smoothS[i]);

    const float cosA = std::cos(corrA) * corrS;
    const float sinA = std::sin(corrA) * corrS;

    Correction& c = raw[i];
    // Rotation is derived in pixels; converting to normalized UV rescales the
    // off-diagonal terms by the frame aspect.
    c.a = cosA;
    c.b = -sinA / aspect;
    c.c = sinA * aspect;
    c.d = cosA;
    c.tx = w > 0.f ? corrX / w : 0.f;
    c.ty = hgt > 0.f ? corrY / hgt : 0.f;

    maxOffset = std::max(maxOffset, std::fabs(c.tx));
    maxOffset = std::max(maxOffset, std::fabs(c.ty));
  }

  // Warping shifts the picture, exposing empty edges. Zoom in by enough to
  // keep the worst-case shift off screen, capped so a very shaky clip softens
  // rather than turning into a crop of its own centre.
  const float zoom = clampf(1.f + 2.f * maxOffset, 1.f, kMaxZoom);
  const float inv = 1.f / zoom;
  for (size_t i = 0; i < n; ++i) {
    Correction& c = raw[i];
    c.a *= inv;
    c.b *= inv;
    c.c *= inv;
    c.d *= inv;
  }

  *zoomOut = zoom;
  *maxOffsetOut = maxOffset;
  return raw;
}

}  // namespace
