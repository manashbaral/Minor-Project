from flask import Flask, render_template, request, jsonify,url_for

app = Flask(__name__)

# Store dispense history (for demo only)
history = []

@app.route('/')
def home():
    return render_template('index.html')

@app.route('/dispense', methods=['POST'])
def dispense():
    data = request.get_json()
    print(f"Dispensing: {data}")
    
    # Here: Send command to ESP32 via Serial
    # For now, simulate success
    history.append(data)
    
    return jsonify({
        "status": "success",
        "message": f"Dispensing {data['water']}ml water, {data['syrup']}ml syrup"
    })

@app.route('/history')
def get_history():
    return jsonify(history)

if __name__ == '__main__':
    app.run(debug=True, port=5000)