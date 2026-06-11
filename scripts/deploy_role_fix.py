import paramiko
import sys
import os

HOST = '193.203.15.249'
USERNAME = 'root'
PASSWORD = 'b9qs9jGu6rD5ojgpGg5'

LOCAL_INDEX_PATH = r'c:\Users\Dell1\OneDrive\Desktop\LocalCodes\CSi-centralized-system\backend\src\api\index.ts'
REMOTE_INDEX_PATH = '/var/www/csi/src/api/index.ts'

def main():
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    
    try:
        ssh.connect(HOST, username=USERNAME, password=PASSWORD, timeout=15)
    except Exception as e:
        print(f"Connection failed: {e}")
        sys.exit(1)

    print("Uploading updated src/api/index.ts to the production server...")
    sftp = ssh.open_sftp()
    try:
        sftp.put(LOCAL_INDEX_PATH, REMOTE_INDEX_PATH)
        print("Upload successful!")
    except Exception as e:
        print(f"SFTP upload failed: {e}")
        sftp.close()
        ssh.close()
        sys.exit(1)
    sftp.close()

    print("Compiling backend and restarting PM2 processes on production...")
    commands = [
        "cd /var/www/csi && npm run build",
        "pm2 restart all --update-env"
    ]
    
    for cmd in commands:
        stdin, stdout, stderr = ssh.exec_command(cmd)
        exit_status = stdout.channel.recv_exit_status()
        print(f"Command: {cmd}")
        print(stdout.read().decode('utf-8'))
        err = stderr.read().decode('utf-8')
        if err:
            print(f"Error/Warning: {err}")
            
    print("Deployment completed successfully!")
    ssh.close()

if __name__ == '__main__':
    main()
