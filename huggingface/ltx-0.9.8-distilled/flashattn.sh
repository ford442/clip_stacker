#MAX_JOBS=6 pip install flash-attn --use-pep517 --no-build-isolation
#git clone https://github.com/Dao-AILab/flash-attention.git
#cd flash-attention/hopper && MAX_JOBS=4 python setup.py install
#MAX_JOBS=6 pip install flash_attn_3 --find-links https://windreamer.github.io/flash-attention3-wheels/cu129_torch280 --extra-index-url https://download.pytorch.org/whl/cu129
MAX_JOBS=6 pip install git+https://github.com/Dao-AILab/flash-attention/releases/download/v2.7.0.post2/flash_attn-2.7.0.post2+cu124torch2.5cxx11abiFALSE-cp310-cp310-linux_x86_64.whl