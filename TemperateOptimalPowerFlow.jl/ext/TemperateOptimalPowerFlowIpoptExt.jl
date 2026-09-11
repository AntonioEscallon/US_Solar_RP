module TemperateOptimalPowerFlowIpoptExt

using TemperateOptimalPowerFlow
using Ipopt
import MathOptInterface as MOI


function TemperateOptimalPowerFlow.get_optimizer()
    MOI.instantiate(Ipopt.Optimizer)
end

function TemperateOptimalPowerFlow.get_silent_optimizer()
    MOI.instantiate(MOI.OptimizerWithAttributes(Ipopt.Optimizer, "print_level" => 0))
end

end # module TemperateOptimalPowerFlowIpoptExt