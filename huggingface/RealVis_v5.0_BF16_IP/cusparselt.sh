wget https://developer.download.nvidia.com/compute/cusparselt/0.6.3/local_installers/cusparselt-local-repo-debian12-0.6.3_1.0-1_amd64.deb
sudo dpkg -i cusparselt-local-repo-debian12-0.6.3_1.0-1_amd64.deb
sudo cp /var/cuda-repo-debian12-0-6-local/cusparselt-*-keyring.gpg /usr/share/keyrings/
sudo apt-get update
sudo apt-get -y install libcusparselt0 libcusparselt-dev