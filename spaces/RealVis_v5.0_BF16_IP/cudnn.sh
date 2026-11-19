
wget https://developer.download.nvidia.com/compute/cudnn/9.5.1/local_installers/cudnn-local-repo-debian12-9.5.1_1.0-1_amd64.deb
sudo dpkg -i cudnn-local-repo-debian12-9.5.1_1.0-1_amd64.deb
sudo cp /var/cuda-repo-debian12-9-5-local/cudnn-*-keyring.gpg /usr/share/keyrings/
sudo apt-get update
sudo apt-get -y install cudnn

