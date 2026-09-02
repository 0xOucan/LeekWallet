
// Common ST7789 Commands and Parameter Components
typedef enum Command {
    CommandNOP                    = 0x00,      // No-op
    CommandSWRESET                = 0x01,      // Software Reset
    CommandSLPOUT                 = 0x11,      // Sleep Out
    CommandNORON                  = 0x13,      // Normal Display Mode On

    CommandINVOFF                 = 0x20,      // Display Inversion Off
    CommandINVON                  = 0x21,      // Display Inversion On
    CommandDISPON                 = 0x29,      // Display On

    CommandCASET                  = 0x2a,      // Column Address Set (4 parameters)
    CommandRASET                  = 0x2b,      // Row Address Set (4 parameters)
    CommandRAMWR                  = 0x2c,      // Memory Write (N parameters)

    CommandMADCTL                 = 0x36,      // Memory Data Access Control (1 parameter)
    CommandMADCTL_1_page          = (1 << 7),  // - Bottom to Top (vs. Top to Bottom)
    CommandMADCTL_1_column        = (1 << 6),  // - Right to Left (vs. Left to Right)
    CommandMADCTL_1_page_column   = (1 << 5),  // - Reverse Mode (vs. Normal Mode)
    CommandMADCTL_1_line_address  = (1 << 4),  // - LCD Refresh Bottom to Top (vs. LCD Refresh Top to Bottom)
    CommandMADCTL_1_rgb           = (1 << 3),  // - BGR (vs. RGB)
    CommandMADCTL_1_data_latch    = (1 << 2),  // - LCD Refresh Right to Left (vs. LCD Refresh Left to Right)

    CommandCOLMOD                 = 0x3a,      // Interface Pixel Format (1 parameter)
    CommandCOLMOD_1_format_65k    = 0x50,      // 65k colors
    CommandCOLMOD_1_format_262k   = 0x30,      // 262k colors
    CommandCOLMOD_1_width_12bit   = 0x03,      // 12-bit pixels
    CommandCOLMOD_1_width_16bit   = 0x05,      // 16-bit pixels
    CommandCOLMOD_1_width_18bit   = 0x06,      // 18-bit pixels

    CommandRAMCTRL                 = 0xb0,      // RAM Control (2 parameters)
    CommandRAMCTRL_1               = 0x00,      // Base parameter
    CommandRAMCTRL_2               = 0xc0,      // Base parameter; MUST include
    CommandRAMCTRL_2_endian_little = 0x08,      // Endian select; little-endian
    CommandRAMCTRL_2_width_6bit    = 0x04,      // RGB bus width; 6 bit

    // How to translate a value to bit-6 of R and B
    CommandRAMCTRL_2_trans_zero    = 0x00,      // translate; 0 => Rlsb, 0 => Blsb
    CommandRAMCTRL_2_trans_one     = 0x10,      // translate; 1 => Rlsb, 1 => Blsb
    CommandRAMCTRL_2_trans_msb     = 0x20,      // translate; Rmsb => Rlsb, Bmsb => Blsb
    CommandRAMCTRL_2_trans_green   = 0x30,      // translate; Gmsb => Rlsb + Blsb

    CommandPORCTRL                = 0xb2,      // Porch Setting (5 parameters
    CommandGCTRL                  = 0xb7,      // Gate Control (1 parameter)
    CommandVCOMS                  = 0xbb,      // VCOM Setting (1 parameter)

    CommandLCMCTRL                = 0xc0,      // LCM Control (@TODO: Look more into this!) (1 parameter)
    CommandLCMCTRL_1_XMY          = (1 << 6),  // - XOR MY setting in command 36h
    CommandLCMCTRL_1_XBGR         = (1 << 5),  // - XOR RGB setting in command 36h
    CommandLCMCTRL_1_XREV         = (1 << 4),  // - XOR inverse setting in command 21h
    CommandLCMCTRL_1_XMX          = (1 << 3),  // - XOR MX setting in command 36h
    CommandLCMCTRL_1_XMH          = (1 << 2),  // - this bit can reverse source output order and only support for RGB interface without RAM mode
    CommandLCMCTRL_1_XMV          = (1 << 1),  // - XOR MV setting in command 36h
    CommandLCMCTRL_1_XGS          = (1 << 0),  // - XOR GS setting in command E4h

    CommandVDVVRHEN               = 0xc2,      // VDV and VRH Command Enable (2 parameters)
    CommandVRHS                   = 0xc3,      // VRH Set (1 parameter)
    CommandVDVS                   = 0xc4,      // VDV Set (1 parameter)

    CommandFRCTRL2                = 0xc6,      // Frame Rate Control in Normal Mode (1 parameter)
    CommandFRCTRL2_1_60hz         = 0x0f,      // - 60hz

    CommandPWCTRL1                = 0xd0,      // Power Control 1 (2 parameters)
    CommandPWCTRL1_1              = 0xa4,      // - First parameter
    CommandPWCTRL1_2_AVDD_6_4     = 0x00,      // - AVD 6.4v
    CommandPWCTRL1_2_AVDD_6_6     = 0x40,      // - AVD 6.6v
    CommandPWCTRL1_2_AVDD_6_8     = 0x80,      // - AVD 6.8v
    CommandPWCTRL1_2_AVCL_4_4     = 0x00,      // - AVCL -4.4v
    CommandPWCTRL1_2_AVCL_4_6     = 0x10,      // - AVCL -4.6v
    CommandPWCTRL1_2_AVCL_4_8     = 0x20,      // - AVCL -4.8v
    CommandPWCTRL1_2_AVCL_5_0     = 0x30,      // - AVCL -5.0v
    CommandPWCTRL1_2_VDS_2_19     = 0x00,      // - AVD 2.19v
    CommandPWCTRL1_2_VDS_2_3      = 0x01,      // - AVD 2.3v
    CommandPWCTRL1_2_VDS_2_4      = 0x02,      // - AVD 2.4v
    CommandPWCTRL1_2_VDS_2_51     = 0x03,      // - AVD 2.51v

    CommandPVGAMCTRL              = 0xe0,      // Positive Voltage Gamma Control (14 parameters)
    CommandNVGAMCTRL              = 0xe1,      // Negative Voltage Gamma Control (14 parameters)

    CommandDone                   = 0xfd,      // Pseudo-Command; internal use only; done commands
    CommandResetPin               = 0xfe,      // Pseudo-Command; internal use only; set reset pin value (1 parameter)
    CommandWait                   = 0xff,      // Pseudo-Command; internal use only; wait Xms (1 parameter)
} Command;

