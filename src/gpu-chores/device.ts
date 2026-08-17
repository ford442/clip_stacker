import { peekGpuDevice } from '../webgpu/gpuDevice';

/**
 * Chores never call `requestDevice()`. They only use a device that preview /
 * export already acquired in this JS realm, or one tests inject via adopt.
 */
let adopted: GPUDevice | null = null;

export function adoptGpuDevice(device: GPUDevice): void {
  adopted = device;
}

export function releaseAdoptedGpuDevice(device?: GPUDevice): void {
  if (!device || adopted === device) adopted = null;
}

export function peekChoresGpuDevice(): GPUDevice | null {
  return adopted ?? peekGpuDevice();
}

export function __resetGpuChoresDeviceForTests(): void {
  adopted = null;
}
