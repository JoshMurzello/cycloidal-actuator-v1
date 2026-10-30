"""Host simulation of the actual CubeIDE USB controller, parser and UART poller.

No board is needed. The simulator compiles the firmware's USER CODE functions
with GPIO, time and UART-register stubs; it does not reimplement the controller.
"""
from pathlib import Path
import subprocess
import tempfile

source = (Path(__file__).resolve().parents[1] / 'firmware/cubeide/Core/Src/main.c').read_text()


def section(name):
    return source.split('/* USER CODE BEGIN ' + name + ' */')[1].split(
        '/* USER CODE END ' + name + ' */')[0]


functions = section('0')
functions = functions[functions.index('static uint8_t Motor_IsMoving'):]

stub = r'''
#include <stdint.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <assert.h>
#include <limits.h>
typedef enum { GPIO_PIN_RESET, GPIO_PIN_SET } GPIO_PinState;
typedef struct { uint32_t RDR, TDR; } UART_Registers;
typedef struct { UART_Registers *Instance; } UART_HandleTypeDef;
static UART_Registers uartRegisters;
static UART_HandleTypeDef huart2 = { &uartRegisters };
static struct { uint32_t CYCCNT; } cycles;
#define DWT (&cycles)
static uint32_t SystemCoreClock=80000000U, tick, edges;
static GPIO_PinState pins[5], button=GPIO_PIN_SET;
#define TB6600_PUL_GPIO_Port 0
#define TB6600_PUL_Pin 0
#define TB6600_ENA_GPIO_Port 0
#define TB6600_ENA_Pin 1
#define LD2_GPIO_Port 0
#define LD2_Pin 2
#define B1_GPIO_Port 0
#define B1_Pin 3
#define TB6600_DIR_GPIO_Port 0
#define TB6600_DIR_Pin 4
static void HAL_GPIO_WritePin(int port,int pin,GPIO_PinState state) {
  (void)port;
  if(pin==0 && state==GPIO_PIN_SET && pins[pin]==GPIO_PIN_RESET) ++edges;
  pins[pin]=state;
}
static GPIO_PinState HAL_GPIO_ReadPin(int port,int pin) {
  (void)port; (void)pin; return button;
}
static uint32_t HAL_GetTick(void) { return tick; }
#define UART_FLAG_ORE 1U
#define UART_FLAG_FE 2U
#define UART_FLAG_NE 4U
#define UART_FLAG_RXNE 8U
#define UART_FLAG_TXE 16U
#define UART_CLEAR_OREF UART_FLAG_ORE
#define UART_CLEAR_FEF UART_FLAG_FE
#define UART_CLEAR_NEF UART_FLAG_NE
static uint32_t uartErrors, uartCleared;
static uint8_t uartRx[512];
static unsigned uartRxCount, uartRxOffset, uartReadCount;
static uint8_t uartTxReady=1;
static int uartFlag(uint32_t flag) {
  if(flag==UART_FLAG_RXNE) {
    if(uartRxOffset==uartRxCount) return 0;
    uartRegisters.RDR=uartRx[uartRxOffset++]; ++uartReadCount; return 1;
  }
  if(flag==UART_FLAG_TXE) return uartTxReady;
  return (uartErrors & flag)!=0;
}
static void uartClear(uint32_t flags) { uartCleared|=flags; uartErrors&=~flags; }
#define __HAL_UART_GET_FLAG(handle,flag) uartFlag(flag)
#define __HAL_UART_CLEAR_FLAG(handle,flags) uartClear(flags)
'''

tests = r'''
static void command(const char *line) {
  while(*line) Serial_ReceiveByte((uint8_t)*line++);
  Serial_ReceiveByte('\n');
}
static void advance(uint32_t milliseconds,uint32_t keepId) {
  for(uint32_t m=0;m<milliseconds;++m) {
    ++tick;
    for(unsigned us=0;us<1000;++us) {
      cycles.CYCCNT+=80U; Motor_Update();
    }
    Button_Update();
    if(keepId && m%100U==99U) {
      char line[32]; snprintf(line,sizeof(line),"KEEP %lu",(unsigned long)keepId);
      command(line);
    }
  }
}
static void reset(void) {
  tick=edges=0U; cycles.CYCCNT=0U;
  memset(pins,0,sizeof(pins));
  motorMode=MOTOR_RELEASED; commandedPosition=displayOrigin=0;
  travelLimit=DEFAULT_TRAVEL_LIMIT; motionDirection=1;
  targetRateHz=currentRateHz=operationRemaining=0U;
  operationStartedMs=operationDurationMs=lastKeepMs=motionId=lastCommandId=0U;
  nextStepCycle=pulseStartedCycle=lastRampMs=rampFraction=0U;
  stepPulseHigh=0U; buttonChangedMs=0U;
  button=lastButtonReading=stableButtonState=GPIO_PIN_SET;
  rxLength=txLength=txOffset=0U; rxDiscard=0U;
  helloPending=0U; statusPending=1U; lastStatusMs=0U;
  uartErrors=uartCleared=uartReadCount=uartRxCount=uartRxOffset=0U;
  uartTxReady=1U; memset(&uartRegisters,0,sizeof(uartRegisters));
  Motor_Release(); stopReason="BOOT";
}
static void loadUart(const char *line) {
  uartRxOffset=0U; uartRxCount=(unsigned)strlen(line);
  assert(uartRxCount<sizeof(uartRx)); memcpy(uartRx,line,uartRxCount);
}
static void drainUart(void) {
  while(uartRxOffset<uartRxCount) Serial_Update();
}
static void expectBad(const char *line) {
  reset(); command("RUN 10 1 25 200 2000"); advance(20,0);
  assert(Motor_IsMoving()); command(line);
  assert(!Motor_IsMoving() && motorMode==MOTOR_HOLD);
  assert(strcmp(stopReason,"BAD_COMMAND")==0);
}
int main(void) {
  reset(); assert(edges==0 && pins[1]==GPIO_PIN_SET);
  command("HELLO"); command("STATUS"); assert(edges==0 && motorMode==MOTOR_RELEASED);
  /* Finite pulses, enable settling, held output, and reverse direction. */
  command("RUN 1 1 25 5 2000");
  advance(9,0); assert(edges==0);
  advance(1,0); assert(edges==1);
  advance(200,1);
  assert(edges==5 && commandedPosition==5 && motorMode==MOTOR_HOLD);
  assert(pins[1]==GPIO_PIN_RESET && strcmp(stopReason,"PULSE_LIMIT")==0);
  advance(200,1); assert(edges==5);
  command("RUN 2 -1 25 5 2000"); assert(pins[4]==GPIO_PIN_RESET);
  advance(9,0); assert(edges==5); advance(201,2);
  assert(edges==10 && commandedPosition==0 && motorMode==MOTOR_HOLD);
  /* Duplicate/stale start never resets finite budgets or extends the lease. */
  reset(); command("RUN 10 1 25 200 2000"); advance(100,0);
  uint32_t started=operationStartedMs, lease=lastKeepMs, remaining=operationRemaining;
  command("RUN 10 1 500 2000 30000");
  assert(operationStartedMs==started && lastKeepMs==lease && operationRemaining==remaining);
  assert(targetRateHz==25 && Motor_IsMoving());
  command("RUN 11 -1 25 200 2000");
  assert(lastCommandId==11 && motionId==10 && motionDirection==1);
  assert(operationStartedMs==started && operationRemaining==remaining);
  advance(100,0); command("KEEP 11"); assert(lastKeepMs==lease);
  command("KEEP 10"); assert(lastKeepMs==tick && operationStartedMs==started);
  /* Status does not renew; expired KEEP cannot revive before or after update. */
  reset(); command("RUN 1 1 25 200 5000"); advance(700,0); command("STATUS");
  advance(49,0); assert(Motor_IsMoving()); advance(1,0);
  assert(motorMode==MOTOR_HOLD && strcmp(stopReason,"LEASE_EXPIRED")==0);
  uint32_t stoppedEdges=edges; command("KEEP 1"); advance(1000,0); assert(edges==stoppedEdges);
  reset(); command("RUN 1 1 25 200 5000");
  tick=MOTION_LEASE_MS; cycles.CYCCNT+=MOTION_LEASE_MS*80000U;
  command("KEEP 1"); assert(lastKeepMs==0); Motor_Update();
  assert(!Motor_IsMoving() && edges==0);
  /* Heartbeats cannot reset the duration or pulse limit. LOAD has its own cap. */
  reset(); command("LOAD 1 1 25 200 500"); advance(500,1);
  assert(motorMode==MOTOR_HOLD && strcmp(stopReason,"TIME_LIMIT")==0);
  assert(edges>0 && edges<200 && operationStartedMs==0);
  stoppedEdges=edges; advance(1000,1); assert(edges==stoppedEdges);
  reset(); command("LOAD 1 1 1 2 5000"); advance(1500,1);
  assert(edges==2 && !Motor_IsMoving() && strcmp(stopReason,"PULSE_LIMIT")==0);
  /* STOP cancels immediately and completes the existing high pulse at 10 us. */
  reset(); command("RUN 1 1 25 200 2000"); cycles.CYCCNT=nextStepCycle; Motor_Update();
  assert(stepPulseHigh && edges==1); uint32_t pulseStart=pulseStartedCycle;
  command("STOP 2"); assert(!Motor_IsMoving() && stepPulseHigh && pins[1]==GPIO_PIN_RESET);
  command("KEEP 1"); command("RUN 1 1 25 200 2000"); assert(!Motor_IsMoving());
  command("RUN 3 -1 25 200 2000"); assert(!Motor_IsMoving() && lastCommandId==3);
  cycles.CYCCNT=pulseStart+9U*80U; Motor_Update(); assert(stepPulseHigh);
  cycles.CYCCNT+=80U; Motor_Update(); assert(!stepPulseHigh && pins[0]==GPIO_PIN_RESET);
  advance(1000,1); assert(edges==1);
  command("RUN 4 -1 25 1 2000"); advance(20,4); assert(edges==2 && commandedPosition==0);
  command("RELEASE 5"); assert(pins[1]==GPIO_PIN_SET && motorMode==MOTOR_RELEASED);
  /* A stale STOP is accepted: stopping remains possible at any ID. */
  reset(); command("RUN 10 1 25 200 2000"); command("STOP 1");
  assert(!Motor_IsMoving() && lastCommandId==10);
  /* Hard travel bound is checked before every edge; reverse remains available. */
  reset(); command("LIMIT 1 2"); command("RUN 2 1 25 200 2000"); advance(200,2);
  assert(edges==2 && commandedPosition==2 && strcmp(stopReason,"TRAVEL_LIMIT")==0);
  command("ZERO 3"); assert(displayOrigin==2 && travelLimit==2 && commandedPosition==2);
  command("RUN 4 1 25 200 2000"); assert(!Motor_IsMoving() && edges==2);
  command("RUN 5 -1 25 200 2000"); advance(300,5);
  assert(edges==6 && commandedPosition==-2 && strcmp(stopReason,"TRAVEL_LIMIT")==0);
  command("RELEASE 6"); assert(commandedPosition==-2 && displayOrigin==2 && travelLimit==2);
  command("LIMIT 7 1"); assert(travelLimit==2 && strcmp(stopReason,"BAD_COMMAND")==0);
  /* Debounce ignores bounce; sustained blue press stops and prevents starts. */
  reset(); command("RUN 1 1 25 200 2000");
  button=GPIO_PIN_RESET; Button_Update(); advance(10,0);
  button=GPIO_PIN_SET; Button_Update(); advance(50,0); assert(Motor_IsMoving());
  button=GPIO_PIN_RESET; Button_Update(); advance(39,0); assert(Motor_IsMoving());
  advance(1,0); assert(!Motor_IsMoving() && strcmp(stopReason,"BUTTON_STOP")==0);
  stoppedEdges=edges; command("RUN 3 1 25 200 2000"); advance(100,3); assert(edges==stoppedEdges);
  button=GPIO_PIN_SET; Button_Update(); advance(40,0);
  command("RUN 4 1 25 1 2000"); advance(20,4); assert(edges==stoppedEdges+1);
  /* Cardinality, numeric ranges, overflows and unknown stale commands fail closed. */
  const char *bad[]={
    "RUN 11 1 25 200", "RUN 11 1 25 200 2000 1", "RUN 11 1 25 200 2000 1 2",
    "RUN 11 0 25 200 2000", "RUN 11 2 25 200 2000", "RUN 11 1 0 200 2000",
    "RUN 11 1 2001 200 2000", "LOAD 11 1 51 200 2000", "RUN 11 1 25 0 2000",
    "RUN 11 1 25 20001 2000", "RUN 11 1 25 200 99", "RUN 11 1 25 200 30001",
    "RUN 0 1 25 200 2000", "RUN -1 1 25 200 2000", "RUN 2147483648 1 25 200 2000",
    "RUN 999999999999999999999999 1 25 200 2000", "RUN 11 1 25x 200 2000",
    "RUN 11 1 25.0 200 2000", "BOGUS 1", "STOP 1 2", "KEEP 1 2", "ZERO 1 2"
  };
  for(unsigned i=0;i<sizeof(bad)/sizeof(bad[0]);++i) expectBad(bad[i]);
  /* Truncated lines execute only on newline; overflow/control-byte discard resyncs. */
  reset(); const char *partial="RUN 1 1 25 2 2000";
  for(const char *p=partial;*p;++p) Serial_ReceiveByte((uint8_t)*p);
  advance(100,0); assert(edges==0 && motorMode==MOTOR_RELEASED);
  Serial_ReceiveByte('\r'); assert(!Motor_IsMoving()); Serial_ReceiveByte('\n');
  advance(100,1); assert(edges==2 && !Motor_IsMoving());
  reset(); command("RUN 1 1 25 200 2000");
  for(unsigned i=0;i<RX_LINE_SIZE;++i) Serial_ReceiveByte('A');
  assert(rxDiscard && !Motor_IsMoving() && strcmp(stopReason,"BAD_COMMAND")==0);
  command("RUN 2 -1 25 1 2000"); assert(!Motor_IsMoving());
  command("RUN 3 -1 25 1 2000"); advance(20,3); assert(edges==1 && commandedPosition==-1);
  reset(); command("RUN 1 1 25 200 2000"); Serial_ReceiveByte(0U);
  assert(rxDiscard && !Motor_IsMoving()); Serial_ReceiveByte('\n');
  assert(!rxDiscard && rxLength==0);
  /* Counter wrap, acceleration clamp and delayed servicing cannot issue a burst. */
  reset(); cycles.CYCCNT=UINT32_MAX-799U; tick=UINT32_MAX-5U;
  command("RUN 1 1 25 5 2000"); advance(300,1);
  assert(edges==5 && commandedPosition==5 && motorMode==MOTOR_HOLD);
  reset(); command("RUN 1 1 500 200 2000"); advance(20,1);
  uint32_t oldRate=currentRateHz, oldEdges=edges;
  tick+=100U; cycles.CYCCNT+=8000000U; Motor_Update();
  assert(currentRateHz<=oldRate+(ACCEL_RATE_HZ_PER_S*10U+999U)/1000U && edges<=oldEdges+1);
  Motor_Update(); assert(edges<=oldEdges+1);
  cycles.CYCCNT+=800U; Motor_Update(); Motor_Update(); assert(edges<=oldEdges+1);
  /* Faster ramp reaches the new rate without weakening larger travel bounds. */
  reset(); command("LIMIT 1 20000"); command("RUN 2 1 2000 20000 5000");
  advance(2100,2); assert(Motor_IsMoving() && currentRateHz==2000);
  assert(edges>1500 && edges<2500); command("STOP 3");
  advance(1,0); assert(!stepPulseHigh);
  reset(); command("LIMIT 1 20000"); commandedPosition=19999;
  command("RUN 2 1 2000 1000 5000"); advance(100,2);
  assert(edges==1 && commandedPosition==20000 && strcmp(stopReason,"TRAVEL_LIMIT")==0);
  command("RUN 3 -1 500 20000 5000"); advance(100,3);
  assert(commandedPosition<20000 && Motor_IsMoving());
  command("STOP 4"); advance(1,0);
  command("LIMIT 5 20001"); assert(travelLimit==20000 && strcmp(stopReason,"BAD_COMMAND")==0);
    /* Hardware wrapper limits RX work, never waits for TX, and stops on overrun. */
  reset(); loadUart("RUN 1 1 25 2 2000\n"); unsigned beforeReads=uartReadCount;
  Serial_Update(); assert(uartReadCount-beforeReads==16 && !Motor_IsMoving());
  drainUart(); assert(Motor_IsMoving());
  uartErrors=UART_FLAG_ORE; loadUart("RUN 2 -1 25 2 2000\n");
  Serial_Update(); assert(!Motor_IsMoving() && rxDiscard);
  assert(uartCleared==(UART_CLEAR_OREF|UART_CLEAR_FEF|UART_CLEAR_NEF));
  drainUart(); assert(!Motor_IsMoving() && strcmp(stopReason,"SERIAL_ERROR")==0);
  loadUart("RUN 3 -1 25 2 2000\n"); drainUart(); assert(Motor_IsMoving());
  uartTxReady=0; uint16_t oldOffset=txOffset;
  for(unsigned i=0;i<100;++i) Serial_Update(); assert(txOffset==oldOffset);
  uartTxReady=1; Serial_Update(); assert(txOffset<=oldOffset+1);
  /* HELLO stops a previous client without movement and produces valid telemetry. */
  command("HELLO"); assert(!Motor_IsMoving() && strcmp(stopReason,"CONNECTED")==0);
  txLength=txOffset=0; Serial_Update();
  assert(strstr(txFrame,"\"type\":\"hello\"") && strstr(txFrame,"\"protocol\":3"));
  txOffset=txLength; Serial_Update();
  assert(strstr(txFrame,"\"type\":\"status\"") && strstr(txFrame,"\"mode\":\"HOLD\""));
  assert(txLength<sizeof(txFrame));
  puts("PASS: actual USB firmware parser, finite motion, watchdog/IDs, Stop/Hold, reverse, bounds/reference, button, malformed RX/overrun, timing/counter wrap, UART poller and telemetry");
}
'''

with tempfile.TemporaryDirectory() as directory:
    c_file = Path(directory) / 'test.c'
    binary = Path(directory) / 'test'
    c_file.write_text(stub + section('PTD') + section('PD') + section('PV') +
                      functions + tests)
    subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror',
                    str(c_file), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
