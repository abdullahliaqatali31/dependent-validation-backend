import paramiko

def deploy_and_run():
    host = "193.203.15.249"
    user = "root"
    pw = "b9qs9jGu6rD5ojgpGg5"

    print(f"Connecting to {host}...")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, username=user, password=pw)

    # Robust cleanup script to run ON the server
    cleanup_sh = """#!/bin/bash
echo "Starting cleanup of 10M+ zombie keys..."
redis-cli --scan --pattern "bull:*:*" | grep -vE "(:id|:meta|:waiting|:active|:completed|:failed|:delayed|:stalled|:repeat|:limiter|:priority)$" | xargs -r -n 1000 redis-cli del
echo "Cleanup complete."
"""
    
    # Upload and execute
    print("Uploading cleanup.sh...")
    stdin, stdout, stderr = client.exec_command(f"echo '{cleanup_sh}' > /tmp/cleanup.sh && chmod +x /tmp/cleanup.sh")
    stdout.read()
    
    print("Executing /tmp/cleanup.sh. This will take a while...")
    # Run in background to avoid SSH timeout
    stdin, stdout, stderr = client.exec_command("nohup /tmp/cleanup.sh > /tmp/cleanup.log 2>&1 &")
    stdout.read()
    
    print("Cleanup started in background. Monitor /tmp/cleanup.log on server.")
    client.close()

if __name__ == "__main__":
    deploy_and_run()
