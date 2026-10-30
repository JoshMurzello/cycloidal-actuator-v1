/* USER CODE BEGIN Header */
/**
  ******************************************************************************
  * @file           : main.c
  * @brief          : Main program body
  ******************************************************************************
  * @attention
  *
  * Copyright (c) 2026 STMicroelectronics.
  * All rights reserved.
  *
  * This software is licensed under terms that can be found in the LICENSE file
  * in the root directory of this software component.
  * If no LICENSE file comes with this software, it is provided AS-IS.
  *
  ******************************************************************************
  */
/* USER CODE END Header */
/* Includes ------------------------------------------------------------------*/
#include "main.h"

/* Private includes ----------------------------------------------------------*/
/* USER CODE BEGIN Includes */
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <errno.h>

/* USER CODE END Includes */

/* Private typedef -----------------------------------------------------------*/
/* USER CODE BEGIN PTD */
typedef enum { MOTOR_RELEASED, MOTOR_HOLD, MOTOR_JOG, MOTOR_LOAD } MotorMode;

/* USER CODE END PTD */

/* Private define ------------------------------------------------------------*/
/* USER CODE BEGIN PD */
#define STEP_PULSE_WIDTH_US 10U
#define ENABLE_DIR_SETTLE_US 10000U
#define MAX_STEP_RATE_HZ 2000U
#define MAX_LOAD_RATE_HZ 50U
#define ACCEL_RATE_HZ_PER_S 1000U
#define START_RATE_HZ 25U
#define DEFAULT_TRAVEL_LIMIT 2000L
#define HARD_TRAVEL_LIMIT 20000L
#define MAX_OPERATION_MS 30000U
#define MOTION_LEASE_MS 750U
#define BUTTON_DEBOUNCE_MS 40U
#define STATUS_PERIOD_MS 100U
#define RX_LINE_SIZE 96U
#define TX_FRAME_SIZE 320U

/* USER CODE END PD */

/* Private macro -------------------------------------------------------------*/
/* USER CODE BEGIN PM */

/* USER CODE END PM */

/* Private variables ---------------------------------------------------------*/
UART_HandleTypeDef huart2;

/* USER CODE BEGIN PV */
static MotorMode motorMode = MOTOR_RELEASED;
static int32_t commandedPosition = 0;
static int32_t displayOrigin = 0;
static int32_t travelLimit = DEFAULT_TRAVEL_LIMIT;
static int8_t motionDirection = 1;
static uint32_t targetRateHz = 0U, currentRateHz = 0U;
static uint32_t operationRemaining = 0U;
static uint32_t operationStartedMs = 0U, operationDurationMs = 0U;
static uint32_t lastKeepMs = 0U, motionId = 0U, lastCommandId = 0U;
static uint32_t nextStepCycle = 0U, pulseStartedCycle = 0U;
static uint32_t lastRampMs = 0U, rampFraction = 0U;
static uint8_t stepPulseHigh = 0U;
static const char *stopReason = "BOOT";
static uint32_t buttonChangedMs = 0U;
static GPIO_PinState lastButtonReading = GPIO_PIN_SET;
static GPIO_PinState stableButtonState = GPIO_PIN_SET;
static char rxLine[RX_LINE_SIZE], txFrame[TX_FRAME_SIZE];
static uint16_t rxLength = 0U, txLength = 0U, txOffset = 0U;
static uint8_t rxDiscard = 0U, helloPending = 0U, statusPending = 1U;
static uint32_t lastStatusMs = 0U;

/* USER CODE END PV */

/* Private function prototypes -----------------------------------------------*/
void SystemClock_Config(void);
static void MX_GPIO_Init(void);
static void MX_USART2_UART_Init(void);
/* USER CODE BEGIN PFP */
static void DWT_Delay_Init(void);
static uint8_t Motor_IsMoving(void);
static void Motor_Stop(const char *reason);
static void Motor_Release(void);
static void Motor_Update(void);
static void Button_Update(void);
static void Serial_Command(char *line);
static void Serial_ReceiveByte(uint8_t byte);
static void Serial_Update(void);

/* USER CODE END PFP */

/* Private user code ---------------------------------------------------------*/
/* USER CODE BEGIN 0 */
static void DWT_Delay_Init(void)
{
  CoreDebug->DEMCR |= CoreDebug_DEMCR_TRCENA_Msk;
  DWT->CYCCNT = 0U;
  DWT->CTRL |= DWT_CTRL_CYCCNTENA_Msk;
}

static uint8_t Motor_IsMoving(void)
{
  return motorMode == MOTOR_JOG || motorMode == MOTOR_LOAD;
}

static void Motor_Stop(const char *reason)
{
  /* Finish a pulse already high; no new rising edges after this call. */
  motorMode = MOTOR_HOLD;
  motionId = 0U;
  targetRateHz = currentRateHz = 0U;
  HAL_GPIO_WritePin(TB6600_ENA_GPIO_Port, TB6600_ENA_Pin, GPIO_PIN_RESET);
  HAL_GPIO_WritePin(LD2_GPIO_Port, LD2_Pin, GPIO_PIN_SET);
  stopReason = reason;
  statusPending = 1U;
}

static void Motor_Release(void)
{
  HAL_GPIO_WritePin(TB6600_PUL_GPIO_Port, TB6600_PUL_Pin, GPIO_PIN_RESET);
  HAL_GPIO_WritePin(TB6600_ENA_GPIO_Port, TB6600_ENA_Pin, GPIO_PIN_SET);
  HAL_GPIO_WritePin(LD2_GPIO_Port, LD2_Pin, GPIO_PIN_RESET);
  stepPulseHigh = 0U;
  motorMode = MOTOR_RELEASED;
  motionId = 0U;
  targetRateHz = currentRateHz = 0U;
  stopReason = "RELEASED";
  statusPending = 1U;
  /* No changes to travel tally or display reference. */
}

static void Motor_Start(uint32_t id, int32_t direction, uint32_t rate,
                        uint32_t pulses, uint32_t duration, MotorMode mode)
{
  if (id <= lastCommandId)
  {
    stopReason = "STALE_ID"; statusPending = 1U; return;
  }
  /* Consume a valid fresh ID even when rejecting: never queue a late start. */
  lastCommandId = id;
  if (Motor_IsMoving() || stepPulseHigh || stableButtonState == GPIO_PIN_RESET)
  {
    stopReason = "BUSY_OR_BUTTON"; statusPending = 1U; return;
  }
  if ((direction > 0 && commandedPosition >= travelLimit) ||
      (direction < 0 && commandedPosition <= -travelLimit))
  {
    stopReason = "TRAVEL_LIMIT"; statusPending = 1U; return;
  }
  motionDirection = (int8_t)direction;
  targetRateHz = rate;
  currentRateHz = rate < START_RATE_HZ ? rate : START_RATE_HZ;
  operationRemaining = pulses;
  operationStartedMs = lastKeepMs = lastRampMs = HAL_GetTick();
  operationDurationMs = duration;
  rampFraction = 0U;
  motionId = id;
  HAL_GPIO_WritePin(TB6600_DIR_GPIO_Port, TB6600_DIR_Pin,
                   direction > 0 ? GPIO_PIN_SET : GPIO_PIN_RESET);
  HAL_GPIO_WritePin(TB6600_ENA_GPIO_Port, TB6600_ENA_Pin, GPIO_PIN_RESET);
  HAL_GPIO_WritePin(LD2_GPIO_Port, LD2_Pin, GPIO_PIN_SET);
  nextStepCycle = DWT->CYCCNT + (SystemCoreClock / 1000000U) * ENABLE_DIR_SETTLE_US;
  motorMode = mode;
  stopReason = "STARTED";
  statusPending = 1U;
}

static void Motor_Update(void)
{
  const uint32_t nowMs = HAL_GetTick();
  if (Motor_IsMoving())
  {
    if ((uint32_t)(nowMs - lastKeepMs) >= MOTION_LEASE_MS)
      Motor_Stop("LEASE_EXPIRED");
    else if ((uint32_t)(nowMs - operationStartedMs) >= operationDurationMs)
      Motor_Stop("TIME_LIMIT");
  }
  const uint32_t nowCycle = DWT->CYCCNT;
  if (stepPulseHigh)
  {
    if ((uint32_t)(nowCycle - pulseStartedCycle) >=
        (SystemCoreClock / 1000000U) * STEP_PULSE_WIDTH_US)
    {
      HAL_GPIO_WritePin(TB6600_PUL_GPIO_Port, TB6600_PUL_Pin, GPIO_PIN_RESET);
      stepPulseHigh = 0U;
      if (Motor_IsMoving())
      {
        if (operationRemaining == 0U) Motor_Stop("PULSE_LIMIT");
        else nextStepCycle = DWT->CYCCNT + SystemCoreClock / currentRateHz;
      }
    }
    return;
  }
  if (!Motor_IsMoving()) return;
  const uint32_t elapsed = nowMs - lastRampMs;
  if (elapsed != 0U)
  {
    lastRampMs = nowMs;
    if (currentRateHz < targetRateHz)
    {
      /* Clamp service delay: no acceleration leap after a debugger pause. */
      rampFraction += (elapsed > 10U ? 10U : elapsed) * ACCEL_RATE_HZ_PER_S;
      const uint32_t increment = rampFraction / 1000U;
      rampFraction %= 1000U;
      const uint32_t remaining = targetRateHz - currentRateHz;
      currentRateHz += increment < remaining ? increment : remaining;
    }
  }
  if ((int32_t)(nowCycle - nextStepCycle) >= 0)
  {
    const int32_t nextPosition = commandedPosition + motionDirection;
    if (nextPosition > travelLimit || nextPosition < -travelLimit)
    {
      Motor_Stop("TRAVEL_LIMIT"); return;
    }
    HAL_GPIO_WritePin(TB6600_PUL_GPIO_Port, TB6600_PUL_Pin, GPIO_PIN_SET);
    pulseStartedCycle = DWT->CYCCNT;
    stepPulseHigh = 1U;
    commandedPosition = nextPosition;
    --operationRemaining;
  }
}

static void Button_Update(void)
{
  const GPIO_PinState reading = HAL_GPIO_ReadPin(B1_GPIO_Port, B1_Pin);
  const uint32_t nowMs = HAL_GetTick();
  if (reading != lastButtonReading)
  {
    lastButtonReading = reading; buttonChangedMs = nowMs;
  }
  if ((uint32_t)(nowMs - buttonChangedMs) >= BUTTON_DEBOUNCE_MS &&
      reading != stableButtonState)
  {
    stableButtonState = reading;
    if (reading == GPIO_PIN_RESET)
    {
      Motor_Stop("BUTTON_STOP");
      if (lastCommandId < 2147483647U) ++lastCommandId;
    }
  }
}

static uint8_t Parse_Number(const char *text, int32_t *value)
{
  char *end;
  if (*text == '\0') return 0U;
  errno = 0;
  const long result = strtol(text, &end, 10);
  if (errno != 0 || *end != '\0' || result < -2147483647L || result > 2147483647L)
    return 0U;
  *value = (int32_t)result;
  return 1U;
}

static void Serial_BadCommand(void)
{
  if (Motor_IsMoving()) Motor_Stop("BAD_COMMAND");
  else { stopReason = "BAD_COMMAND"; statusPending = 1U; }
}

static void Serial_Command(char *line)
{
  char *tokens[7];
  unsigned count = 0U;
  char *token = strtok(line, " \t");
  while (token != NULL && count < 7U)
  {
    tokens[count++] = token; token = strtok(NULL, " \t");
  }
  if (count == 0U) return;
  if (token != NULL) { Serial_BadCommand(); return; }
  if (count == 1U && strcmp(tokens[0], "HELLO") == 0)
  {
    if (Motor_IsMoving()) Motor_Stop("CONNECTED");
    helloPending = statusPending = 1U; return;
  }
  if (count == 1U && strcmp(tokens[0], "STATUS") == 0)
  {
    statusPending = 1U; return;
  }
  int32_t values[6];
  for (unsigned i = 1U; i < count; ++i)
    if (!Parse_Number(tokens[i], &values[i - 1U])) { Serial_BadCommand(); return; }
  if (count < 2U || values[0] <= 0) { Serial_BadCommand(); return; }
  const uint32_t id = (uint32_t)values[0];
  if (count == 2U && strcmp(tokens[0], "KEEP") == 0)
  {
    /* Heartbeat cannot start/restart motion or extend operation budgets. */
    if (Motor_IsMoving() && id == motionId &&
        (uint32_t)(HAL_GetTick() - lastKeepMs) < MOTION_LEASE_MS)
      lastKeepMs = HAL_GetTick();
    return;
  }
  if (count == 2U && strcmp(tokens[0], "STOP") == 0)
  {
    if (id > lastCommandId) lastCommandId = id;
    Motor_Stop("STOPPED"); return;
  }
  if (count == 6U && (strcmp(tokens[0], "RUN") == 0 || strcmp(tokens[0], "LOAD") == 0))
  {
    const MotorMode mode = strcmp(tokens[0], "LOAD") == 0 ? MOTOR_LOAD : MOTOR_JOG;
    if ((values[1] != 1 && values[1] != -1) || values[2] < 1 ||
        values[2] > (int32_t)(mode == MOTOR_LOAD ? MAX_LOAD_RATE_HZ : MAX_STEP_RATE_HZ) ||
        values[3] < 1 || values[3] > HARD_TRAVEL_LIMIT || values[4] < 100 ||
        values[4] > (int32_t)MAX_OPERATION_MS)
    { Serial_BadCommand(); return; }
    Motor_Start(id, values[1], (uint32_t)values[2], (uint32_t)values[3],
                (uint32_t)values[4], mode);
    return;
  }
  if (!((count == 2U && (strcmp(tokens[0], "RELEASE") == 0 || strcmp(tokens[0], "ZERO") == 0)) ||
        (count == 3U && strcmp(tokens[0], "LIMIT") == 0)))
  { Serial_BadCommand(); return; }
  if (id <= lastCommandId)
  { stopReason = "STALE_ID"; statusPending = 1U; return; }
  if (count == 2U && strcmp(tokens[0], "RELEASE") == 0)
  {
    lastCommandId = id; Motor_Release(); return;
  }
  if (count == 2U && strcmp(tokens[0], "ZERO") == 0 && !Motor_IsMoving())
  {
    lastCommandId = id; displayOrigin = commandedPosition;
    stopReason = "REFERENCE_SET"; statusPending = 1U; return;
  }
  if (count == 3U && strcmp(tokens[0], "LIMIT") == 0 && !Motor_IsMoving() &&
      values[1] >= 1 && values[1] <= HARD_TRAVEL_LIMIT &&
      commandedPosition <= values[1] && commandedPosition >= -values[1])
  {
    lastCommandId = id; travelLimit = values[1];
    stopReason = "CONFIGURED"; statusPending = 1U; return;
  }
  Serial_BadCommand();
}

static void Serial_ReceiveByte(uint8_t byte)
{
  if (byte == '\r') return;
  if (byte == '\n')
  {
    if (!rxDiscard)
    {
      rxLine[rxLength] = '\0'; Serial_Command(rxLine);
    }
    rxLength = 0U; rxDiscard = 0U; return;
  }
  if (rxDiscard) return;
  if (byte < 32U || byte > 126U || rxLength >= RX_LINE_SIZE - 1U)
  {
    rxDiscard = 1U; rxLength = 0U; Serial_BadCommand(); return;
  }
  rxLine[rxLength++] = (char)byte;
}

static void Serial_Update(void)
{
  /* Poll ready bytes only: no blocking HAL receive/transmit or IRQ changes. */
  if (__HAL_UART_GET_FLAG(&huart2, UART_FLAG_ORE) ||
      __HAL_UART_GET_FLAG(&huart2, UART_FLAG_FE) ||
      __HAL_UART_GET_FLAG(&huart2, UART_FLAG_NE))
  {
    __HAL_UART_CLEAR_FLAG(&huart2, UART_CLEAR_OREF | UART_CLEAR_FEF | UART_CLEAR_NEF);
    rxDiscard = 1U; rxLength = 0U;
    if (Motor_IsMoving()) Motor_Stop("SERIAL_ERROR");
  }
  for (unsigned i = 0; i < 16U && __HAL_UART_GET_FLAG(&huart2, UART_FLAG_RXNE); ++i)
    Serial_ReceiveByte((uint8_t)(huart2.Instance->RDR & 0xffU));
  /* Limit formatting work to low-pulse state; telemetry never blocks stepping. */
  if (txOffset == txLength && !stepPulseHigh)
  {
    const uint32_t nowMs = HAL_GetTick();
    if (helloPending)
    {
      txLength = (uint16_t)snprintf(txFrame, sizeof(txFrame),
        "{\"type\":\"hello\",\"protocol\":3,\"firmware\":\"usb-panel-3\"}\n");
      txOffset = 0U; helloPending = 0U;
    }
    else if (statusPending || (uint32_t)(nowMs - lastStatusMs) >= STATUS_PERIOD_MS)
    {
      const char *mode = motorMode == MOTOR_JOG ? "JOG" : motorMode == MOTOR_LOAD ?
                        "LOAD" : motorMode == MOTOR_HOLD ? "HOLD" : "RELEASED";
      txLength = (uint16_t)snprintf(txFrame, sizeof(txFrame),
        "{\"type\":\"status\",\"protocol\":3,\"mode\":\"%s\",\"position\":%ld,\"origin\":%ld,\"limit\":%ld,\"rate\":%lu,\"current\":%lu,\"remaining\":%lu,\"motion\":%lu,\"last\":%lu,\"reason\":\"%s\"}\n",
        mode, (long)commandedPosition, (long)displayOrigin, (long)travelLimit,
        (unsigned long)targetRateHz, (unsigned long)currentRateHz,
        (unsigned long)operationRemaining, (unsigned long)motionId,
        (unsigned long)lastCommandId, stopReason);
      txOffset = 0U; lastStatusMs = nowMs; statusPending = 0U;
    }
  }
  if (txOffset < txLength && __HAL_UART_GET_FLAG(&huart2, UART_FLAG_TXE))
    huart2.Instance->TDR = (uint8_t)txFrame[txOffset++];
}

/* USER CODE END 0 */

/**
  * @brief  The application entry point.
  * @retval int
  */
int main(void)
{

  /* USER CODE BEGIN 1 */

  /* USER CODE END 1 */

  /* MCU Configuration--------------------------------------------------------*/

  /* Reset of all peripherals, Initializes the Flash interface and the Systick. */
  HAL_Init();

  /* USER CODE BEGIN Init */

  /* USER CODE END Init */

  /* Configure the system clock */
  SystemClock_Config();

  /* USER CODE BEGIN SysInit */

  /* USER CODE END SysInit */

  /* Initialize all configured peripherals */
  MX_GPIO_Init();
  MX_USART2_UART_Init();
  /* USER CODE BEGIN 2 */
DWT_Delay_Init();
  HAL_GPIO_WritePin(TB6600_DIR_GPIO_Port, TB6600_DIR_Pin, GPIO_PIN_SET);
  Motor_Release();
  stopReason = "BOOT";
  lastButtonReading = HAL_GPIO_ReadPin(B1_GPIO_Port, B1_Pin);
  stableButtonState = lastButtonReading;

/* USER CODE END 2 */

  /* Infinite loop */
  /* USER CODE BEGIN WHILE */
  while (1)
  {
    Button_Update();
    Motor_Update();
    Serial_Update();
    /* USER CODE END WHILE */

    /* USER CODE BEGIN 3 */
  }
  /* USER CODE END 3 */
}

/**
  * @brief System Clock Configuration
  * @retval None
  */
void SystemClock_Config(void)
{
  RCC_OscInitTypeDef RCC_OscInitStruct = {0};
  RCC_ClkInitTypeDef RCC_ClkInitStruct = {0};

  /** Configure the main internal regulator output voltage
  */
  if (HAL_PWREx_ControlVoltageScaling(PWR_REGULATOR_VOLTAGE_SCALE1) != HAL_OK)
  {
    Error_Handler();
  }

  /** Initializes the RCC Oscillators according to the specified parameters
  * in the RCC_OscInitTypeDef structure.
  */
  RCC_OscInitStruct.OscillatorType = RCC_OSCILLATORTYPE_HSI;
  RCC_OscInitStruct.HSIState = RCC_HSI_ON;
  RCC_OscInitStruct.HSICalibrationValue = RCC_HSICALIBRATION_DEFAULT;
  RCC_OscInitStruct.PLL.PLLState = RCC_PLL_ON;
  RCC_OscInitStruct.PLL.PLLSource = RCC_PLLSOURCE_HSI;
  RCC_OscInitStruct.PLL.PLLM = 1;
  RCC_OscInitStruct.PLL.PLLN = 10;
  RCC_OscInitStruct.PLL.PLLP = RCC_PLLP_DIV7;
  RCC_OscInitStruct.PLL.PLLQ = RCC_PLLQ_DIV2;
  RCC_OscInitStruct.PLL.PLLR = RCC_PLLR_DIV2;
  if (HAL_RCC_OscConfig(&RCC_OscInitStruct) != HAL_OK)
  {
    Error_Handler();
  }

  /** Initializes the CPU, AHB and APB buses clocks
  */
  RCC_ClkInitStruct.ClockType = RCC_CLOCKTYPE_HCLK|RCC_CLOCKTYPE_SYSCLK
                              |RCC_CLOCKTYPE_PCLK1|RCC_CLOCKTYPE_PCLK2;
  RCC_ClkInitStruct.SYSCLKSource = RCC_SYSCLKSOURCE_PLLCLK;
  RCC_ClkInitStruct.AHBCLKDivider = RCC_SYSCLK_DIV1;
  RCC_ClkInitStruct.APB1CLKDivider = RCC_HCLK_DIV1;
  RCC_ClkInitStruct.APB2CLKDivider = RCC_HCLK_DIV1;

  if (HAL_RCC_ClockConfig(&RCC_ClkInitStruct, FLASH_LATENCY_4) != HAL_OK)
  {
    Error_Handler();
  }
}

/**
  * @brief USART2 Initialization Function
  * @param None
  * @retval None
  */
static void MX_USART2_UART_Init(void)
{

  /* USER CODE BEGIN USART2_Init 0 */

  /* USER CODE END USART2_Init 0 */

  /* USER CODE BEGIN USART2_Init 1 */

  /* USER CODE END USART2_Init 1 */
  huart2.Instance = USART2;
  huart2.Init.BaudRate = 115200;
  huart2.Init.WordLength = UART_WORDLENGTH_8B;
  huart2.Init.StopBits = UART_STOPBITS_1;
  huart2.Init.Parity = UART_PARITY_NONE;
  huart2.Init.Mode = UART_MODE_TX_RX;
  huart2.Init.HwFlowCtl = UART_HWCONTROL_NONE;
  huart2.Init.OverSampling = UART_OVERSAMPLING_16;
  huart2.Init.OneBitSampling = UART_ONE_BIT_SAMPLE_DISABLE;
  huart2.AdvancedInit.AdvFeatureInit = UART_ADVFEATURE_NO_INIT;
  if (HAL_UART_Init(&huart2) != HAL_OK)
  {
    Error_Handler();
  }
  /* USER CODE BEGIN USART2_Init 2 */

  /* USER CODE END USART2_Init 2 */

}

/**
  * @brief GPIO Initialization Function
  * @param None
  * @retval None
  */
static void MX_GPIO_Init(void)
{
  GPIO_InitTypeDef GPIO_InitStruct = {0};
/* USER CODE BEGIN MX_GPIO_Init_1 */
/* USER CODE END MX_GPIO_Init_1 */

  /* GPIO Ports Clock Enable */
  __HAL_RCC_GPIOC_CLK_ENABLE();
  __HAL_RCC_GPIOH_CLK_ENABLE();
  __HAL_RCC_GPIOA_CLK_ENABLE();
  __HAL_RCC_GPIOB_CLK_ENABLE();

  /*Configure GPIO pin Output Level */
  HAL_GPIO_WritePin(LD2_GPIO_Port, LD2_Pin, GPIO_PIN_RESET);

  /*Configure GPIO pin Output Level */
  HAL_GPIO_WritePin(GPIOB, GPIO_PIN_4|GPIO_PIN_5|GPIO_PIN_6, GPIO_PIN_RESET);

  /*Configure GPIO pin : B1_Pin */
  GPIO_InitStruct.Pin = B1_Pin;
  GPIO_InitStruct.Mode = GPIO_MODE_IT_FALLING;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  HAL_GPIO_Init(B1_GPIO_Port, &GPIO_InitStruct);

  /*Configure GPIO pin : LD2_Pin */
  GPIO_InitStruct.Pin = LD2_Pin;
  GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_LOW;
  HAL_GPIO_Init(LD2_GPIO_Port, &GPIO_InitStruct);

  /*Configure GPIO pins : PB4 PB5 PB6 */
  GPIO_InitStruct.Pin = GPIO_PIN_4|GPIO_PIN_5|GPIO_PIN_6;
  GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_LOW;
  HAL_GPIO_Init(GPIOB, &GPIO_InitStruct);

/* USER CODE BEGIN MX_GPIO_Init_2 */
  /* TB6600 step, direction, and enable outputs on Arduino D5, D4, and D10. */
  HAL_GPIO_WritePin(GPIOB, TB6600_PUL_Pin|TB6600_DIR_Pin|TB6600_ENA_Pin,
                    GPIO_PIN_RESET);

  GPIO_InitStruct.Pin = TB6600_PUL_Pin|TB6600_DIR_Pin|TB6600_ENA_Pin;
  GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_HIGH;
  HAL_GPIO_Init(GPIOB, &GPIO_InitStruct);
/* USER CODE END MX_GPIO_Init_2 */
}

/* USER CODE BEGIN 4 */

/* USER CODE END 4 */

/**
  * @brief  This function is executed in case of error occurrence.
  * @retval None
  */
void Error_Handler(void)
{
  /* USER CODE BEGIN Error_Handler_Debug */
  /* User can add his own implementation to report the HAL error return state */
  __disable_irq();
  while (1)
  {
  }
  /* USER CODE END Error_Handler_Debug */
}

#ifdef  USE_FULL_ASSERT
/**
  * @brief  Reports the name of the source file and the source line number
  *         where the assert_param error has occurred.
  * @param  file: pointer to the source file name
  * @param  line: assert_param error line source number
  * @retval None
  */
void assert_failed(uint8_t *file, uint32_t line)
{
  /* USER CODE BEGIN 6 */
  /* User can add his own implementation to report the file name and line number,
     ex: printf("Wrong parameters value: file %s on line %d\r\n", file, line) */
  /* USER CODE END 6 */
}
#endif /* USE_FULL_ASSERT */
