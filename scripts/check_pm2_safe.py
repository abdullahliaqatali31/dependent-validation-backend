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

    print("Checking PM2 status safely (with fallback encoding)...")
    stdin, stdout, stderr = ssh.exec_command("pm2 status")
    stdout.channel.recv_exit_status()
    
    # Safely print stdout and stderr ignoring cp1252 mismatches
    print("=== PM2 Status Output ===")
    out_text = stdout.read().decode('utf-8', errors='replace')
    sys.stdout.buffer.write(out_text.encode('utf-8'))
    print()
    
    err_text = stderr.read().decode('utf-8', errors='replace')
    if err_text.strip():
        print("=== Error Output ===")
        sys.stdout.buffer.write(err_text.encode('utf-8'))
        print()

    ssh.close()

if __name__ == '__main__':
    main()
