import paramiko
import sys

HOST = '193.203.15.249'
USERNAME = 'root'
PASSWORD = 'b9qs9jGu6rD5ojgpGg5'

def main():
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    
    try:
        ssh.connect(HOST, username=USERNAME, password=PASSWORD, timeout=15)
    except Exception as e:
        print(f"Connection failed: {e}")
        sys.exit(1)

    print("Aligning production server repository with the latest GitHub main branch...")
    commands = [
        "cd /var/www/csi && git fetch origin",
        "cd /var/www/csi && git reset --hard origin/main"
    ]
    
    for cmd in commands:
        stdin, stdout, stderr = ssh.exec_command(cmd)
        exit_status = stdout.channel.recv_exit_status()
        print(f"Command: {cmd}")
        print(stdout.read().decode('utf-8'))
        err = stderr.read().decode('utf-8')
        if err:
            print(f"Error: {err}")

    ssh.close()

if __name__ == '__main__':
    main()
