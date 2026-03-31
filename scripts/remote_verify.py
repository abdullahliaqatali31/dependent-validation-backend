import paramiko
import os
import sys
import json
from datetime import datetime

# Server Configuration
SERVER_IP = '193.203.15.249'
SSH_USER = 'root'
SSH_PASSWORD = 'b9qs9jGu6rD5ojgpGg5'

def run_command(client, command):
    # print(f"Executing: {command}")
    stdin, stdout, stderr = client.exec_command(command)
    exit_status = stdout.channel.recv_exit_status()
    output = stdout.read().decode('utf-8')
    error = stderr.read().decode('utf-8')
    return output, error, exit_status

def main():
    try:
        # Initialize SSH client
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        
        # Connect to server
        print(f"Connecting to {SERVER_IP}...")
        client.connect(hostname=SERVER_IP, username=SSH_USER, password=SSH_PASSWORD)

        print("Checking local profile count...")
        # Since we are root, we can try psql directly
        db_cmd = "PGPASSWORD=csi_password psql -h localhost -d csi_db -U csi -c \"SELECT COUNT(*) FROM profiles;\""
        output, err, _ = run_command(client, db_cmd)
        if err:
             print(f"DB Error: {err}")
        else:
             print(f"Local Profile Count Output:\n{output}")

        print("--- Verification Finished ---")
        client.close()

    except Exception as e:
        print(f"An error occurred: {e}")

if __name__ == "__main__":
    main()
