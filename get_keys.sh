#!/bin/bash
# Install tinytuya and run the wizard to extract device local keys

echo "Installing tinytuya..."
pip3 install tinytuya --quiet

echo ""
echo "Starting Tuya wizard..."
echo "It will ask for:"
echo "  - Your Tuya/SmartLife/Kerui app email"
echo "  - Your password"
echo "  - Your region (1=US, 2=Europe, 3=China, 4=India)"
echo ""

python3 -m tinytuya wizard
