"""Protocol-3 identification/status diagnostic; never starts motion.

HELLO stops an active JOG/LOAD and keeps the driver commanded in HOLD (ENA low).
It leaves an already RELEASED driver released; STATUS only requests telemetry.
"""
import argparse
import json
import os
import select
import termios
import time
p=argparse.ArgumentParser(); p.add_argument('port'); args=p.parse_args()
fd=os.open(args.port,os.O_RDWR|os.O_NOCTTY|os.O_NONBLOCK)
old=termios.tcgetattr(fd)
try:
 attrs=termios.tcgetattr(fd)
 attrs[0]=0; attrs[1]=0; attrs[2]=termios.CS8|termios.CLOCAL|termios.CREAD; attrs[3]=0
 attrs[4]=termios.B115200; attrs[5]=termios.B115200
 attrs[6][termios.VMIN]=0; attrs[6][termios.VTIME]=0
 termios.tcsetattr(fd,termios.TCSANOW,attrs)
 termios.tcflush(fd,termios.TCIFLUSH)
 os.write(fd,b'HELLO\nSTATUS\n')
 buffer=b''; hello=False; status=None; deadline=time.monotonic()+4
 while time.monotonic()<deadline:
  ready,_,_=select.select([fd],[],[],0.2)
  if not ready: continue
  buffer+=os.read(fd,4096)
  while b'\n' in buffer:
   line,buffer=buffer.split(b'\n',1)
   try: item=json.loads(line)
   except (ValueError,UnicodeDecodeError): continue
   if item.get('type')=='hello' and item.get('protocol')==3 and item.get('firmware')=='usb-panel-3': hello=True
   if item.get('type')=='status' and item.get('protocol')==3: status=item
  if hello and status:
   print(json.dumps({'verified':True,'port':args.port,'status':status})); break
 else:
  raise SystemExit('No matching protocol-3 handshake/status received; do not enable panel motion.')
finally:
 termios.tcsetattr(fd,termios.TCSANOW,old); os.close(fd)
