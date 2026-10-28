// Constants the C library only provides as extensions. The modules build as
// strict C++17 (no GNU extensions), where <cmath> need not define M_PI.
#pragma once

namespace cs {

constexpr double kPi = 3.14159265358979323846;
constexpr float kPiF = 3.14159265358979323846f;

}  // namespace cs
