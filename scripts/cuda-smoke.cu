#include <cuda_runtime.h>
#include <cstdio>
__global__ void add(int *x) { x[threadIdx.x] += 7; }
int main() {
 int *d=nullptr, h[32]={};
 cudaError_t e=cudaMalloc(&d,sizeof(h)); if(e!=cudaSuccess){puts(cudaGetErrorString(e));return 1;}
 cudaMemcpy(d,h,sizeof(h),cudaMemcpyHostToDevice);
 add<<<1,32>>>(d); e=cudaDeviceSynchronize();
 if(e!=cudaSuccess){puts(cudaGetErrorString(e));cudaFree(d);return 2;}
 e=cudaMemcpy(h,d,sizeof(h),cudaMemcpyDeviceToHost); cudaFree(d);
 if(e!=cudaSuccess)return 3;
 for(int x:h)if(x!=7)return 4;
 puts("PASS: CUDA kernel, allocation, H2D/D2H, synchronization (128 bytes)");
}
